require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const {
    AccessToken,
    RoomServiceClient
} = require("livekit-server-sdk");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

app.use(
    express.json({
        limit: "5mb"
    })
);

app.use(
    express.static(
        path.join(__dirname, "public")
    )
);

/* =========================
   MATCHING STATE
   ========================= */

const waitingUsers = new Map();
const matches = new Map();
const matchRooms = new Map();

/*
 * userId  = постоянный пользователь
 * socketId = конкретная вкладка / сессия
 */

/* =========================
   LIVEKIT STATE
   ========================= */

/*
 * roomName -> Map(userId -> Set(identity))
 *
 * Один пользователь может иметь
 * несколько вкладок одновременно.
 */

const liveKitParticipants = new Map();

/* =========================
   FILES
   ========================= */

const REPORTS_FILE =
    path.join(__dirname, "reports.json");

const BANS_FILE =
    path.join(__dirname, "bans.json");

/* =========================
   ADMIN
   ========================= */

const adminSessions = new Map();

const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD || "";

/* =========================
   LIVEKIT ADMIN CLIENT
   ========================= */

function getLiveKitHttpUrl() {
    let url =
        process.env.LIVEKIT_URL || "";

    url = url.trim();

    if (
        url.startsWith("wss://")
    ) {
        return (
            "https://" +
            url.slice(6)
        );
    }

    if (
        url.startsWith("ws://")
    ) {
        return (
            "http://" +
            url.slice(5)
        );
    }

    return url;
}

let liveKitRoomService = null;

if (
    process.env.LIVEKIT_URL &&
    process.env.LIVEKIT_API_KEY &&
    process.env.LIVEKIT_API_SECRET
) {
    liveKitRoomService =
        new RoomServiceClient(
            getLiveKitHttpUrl(),
            process.env.LIVEKIT_API_KEY,
            process.env.LIVEKIT_API_SECRET
        );
}

/* =========================
   HELPERS
   ========================= */

function randomId(prefix) {
    return (
        prefix +
        crypto
            .randomBytes(12)
            .toString("hex")
    );
}

/* =========================
   COOKIES
   ========================= */

function parseCookies(req) {
    const header =
        req.headers.cookie || "";

    const cookies = {};

    header
        .split(";")
        .forEach(function (part) {
            const index =
                part.indexOf("=");

            if (index === -1) {
                return;
            }

            const key =
                part
                    .slice(0, index)
                    .trim();

            const value =
                decodeURIComponent(
                    part
                        .slice(index + 1)
                        .trim()
                );

            cookies[key] = value;
        });

    return cookies;
}

function setCookie(
    res,
    name,
    value,
    options = {}
) {
    let cookie =
        `${name}=${encodeURIComponent(value)}`;

    cookie += "; Path=/";

    if (
        options.httpOnly !== false
    ) {
        cookie += "; HttpOnly";
    }

    if (options.sameSite) {
        cookie +=
            `; SameSite=${options.sameSite}`;
    }

    if (
        options.maxAge !== undefined
    ) {
        cookie +=
            `; Max-Age=${options.maxAge}`;
    }

    if (options.secure) {
        cookie += "; Secure";
    }

    res.append(
        "Set-Cookie",
        cookie
    );
}

function clearCookie(
    res,
    name
) {
    res.append(
        "Set-Cookie",
        `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`
    );
}

/* =========================
   USER ID
   ========================= */

function ensureUserId(
    req,
    res
) {
    const cookies =
        parseCookies(req);

    let userId =
        cookies.icechat_uid;

    if (
        !userId ||
        !/^usr_[a-f0-9]{24}$/.test(
            userId
        )
    ) {
        userId =
            randomId("usr_");

        setCookie(
            res,
            "icechat_uid",
            userId,
            {
                httpOnly: true,
                sameSite: "Lax",
                maxAge:
                    60 *
                    60 *
                    24 *
                    365 *
                    5
            }
        );
    }

    return userId;
}

function getUserId(req) {
    const cookies =
        parseCookies(req);

    const userId =
        cookies.icechat_uid;

    if (
        !userId ||
        !/^usr_[a-f0-9]{24}$/.test(
            userId
        )
    ) {
        return null;
    }

    return userId;
}

/* =========================
   JSON STORAGE
   ========================= */

function readJsonArray(file) {
    try {
        if (
            !fs.existsSync(file)
        ) {
            return [];
        }

        const data =
            fs.readFileSync(
                file,
                "utf8"
            );

        const parsed =
            JSON.parse(data);

        return Array.isArray(parsed)
            ? parsed
            : [];

    } catch (error) {
        console.error(
            `Ошибка чтения ${path.basename(file)}:`,
            error.message
        );

        return [];
    }
}

function writeJsonArray(
    file,
    data
) {
    fs.writeFileSync(
        file,
        JSON.stringify(
            data,
            null,
            2
        ),
        "utf8"
    );
}

function readReports() {
    return readJsonArray(
        REPORTS_FILE
    );
}

function writeReports(
    reports
) {
    writeJsonArray(
        REPORTS_FILE,
        reports
    );
}

function readBans() {
    return readJsonArray(
        BANS_FILE
    );
}

function writeBans(
    bans
) {
    writeJsonArray(
        BANS_FILE,
        bans
    );
}

/* =========================
   BAN CHECK
   ========================= */

function getActiveBan(
    userId
) {
    if (!userId) {
        return null;
    }

    const bans =
        readBans();

    let changed = false;

    const now =
        Date.now();

    const activeBans =
        bans.filter(
            function (ban) {

                if (
                    ban.expiresAt &&
                    new Date(
                        ban.expiresAt
                    ).getTime() <=
                        now
                ) {
                    changed = true;

                    return false;
                }

                return true;
            }
        );

    if (changed) {
        writeBans(
            activeBans
        );
    }

    return (
        activeBans.find(
            function (ban) {
                return (
                    ban.userId ===
                    userId
                );
            }
        ) || null
    );
}

/* =========================
   ADMIN AUTH
   ========================= */

function requireAdmin(
    req,
    res,
    next
) {
    const cookies =
        parseCookies(req);

    const sessionId =
        cookies.icechat_admin;

    if (
        !sessionId ||
        !adminSessions.has(
            sessionId
        )
    ) {
        return res.status(401).json({
            error:
                "Admin authorization required"
        });
    }

    next();
}

/* =========================
   IP / COUNTRY
   ========================= */

function getClientIp(req) {
    const forwarded =
        req.headers[
            "x-forwarded-for"
        ];

    if (forwarded) {
        return forwarded
            .split(",")[0]
            .trim();
    }

    return (
        req.headers[
            "cf-connecting-ip"
        ] ||
        req.socket.remoteAddress ||
        ""
    )
        .replace(
            "::ffff:",
            ""
        )
        .trim();
}

function countryName(code) {
    const names = {
        DE: "Германия",
        RU: "Российская федерация",
        US: "США",
        GB: "Англия",
        FR: "Франция",
        IT: "Италия",
        ES: "Испания",
        PL: "Польша",
        UA: "Украина",
        KZ: "Казахстан",
        BY: "Беларусь",
        NL: "Нидерланды",
        BE: "Бельгия",
        AT: "Австрия",
        CH: "Швейцария",
        CZ: "Чехия",
        SE: "Швеция",
        NO: "Норвегия",
        FI: "Финляндия",
        DK: "Дания",
        CA: "Канада",
        AU: "Австралия",
        JP: "Япония",
        KR: "Южная Корея",
        CN: "Китай",
        TR: "Турция",
        IN: "Индия",
        BR: "Бразилия",
        MX: "Мексика"
    };

    return (
        names[code] ||
        code ||
        "Неизвестно"
    );
}

async function getCountry(req) {
    if (
        req.headers[
            "cf-ipcountry"
        ]
    ) {
        const code =
            req.headers[
                "cf-ipcountry"
            ].toUpperCase();

        if (code !== "XX") {
            return {
                code:
                    code,
                name:
                    countryName(
                        code
                    )
            };
        }
    }

    if (
        req.headers[
            "x-country-code"
        ]
    ) {
        const code =
            req.headers[
                "x-country-code"
            ].toUpperCase();

        return {
            code:
                code,

            name:
                countryName(
                    code
                )
        };
    }

    const ip =
        getClientIp(req);

    if (
        !ip ||
        ip === "127.0.0.1" ||
        ip === "::1"
    ) {
        return {
            code:
                "UN",

            name:
                "Неизвестно"
        };
    }

    try {
        const response =
            await fetch(
                `https://ipapi.co/${encodeURIComponent(ip)}/json/`
            );

        if (!response.ok) {
            throw new Error(
                "Geo request failed"
            );
        }

        const data =
            await response.json();

        const code =
            String(
                data.country_code ||
                "UN"
            ).toUpperCase();

        return {
            code:
                code,

            name:
                data.country_name ||
                countryName(code)
        };

    } catch (error) {
        console.log(
            "Не удалось определить страну:",
            error.message
        );

        return {
            code:
                "UN",

            name:
                "Неизвестно"
        };
    }
}

/* =========================
   LIVEKIT TRACKING
   ========================= */

function registerLiveKitParticipant(
    roomName,
    userId,
    identity
) {
    if (
        !liveKitParticipants.has(
            roomName
        )
    ) {
        liveKitParticipants.set(
            roomName,
            new Map()
        );
    }

    const roomUsers =
        liveKitParticipants.get(
            roomName
        );

    if (
        !roomUsers.has(
            userId
        )
    ) {
        roomUsers.set(
            userId,
            new Set()
        );
    }

    roomUsers
        .get(userId)
        .add(identity);
}

function getLiveKitIdentities(
    roomName,
    userId
) {
    const roomUsers =
        liveKitParticipants.get(
            roomName
        );

    if (!roomUsers) {
        return [];
    }

    const identities =
        roomUsers.get(
            userId
        );

    if (!identities) {
        return [];
    }

    return Array.from(
        identities
    );
}

function removeTrackedIdentity(
    roomName,
    userId,
    identity
) {
    const roomUsers =
        liveKitParticipants.get(
            roomName
        );

    if (!roomUsers) {
        return;
    }

    const identities =
        roomUsers.get(
            userId
        );

    if (!identities) {
        return;
    }

    identities.delete(
        identity
    );

    if (
        identities.size === 0
    ) {
        roomUsers.delete(
            userId
        );
    }

    if (
        roomUsers.size === 0
    ) {
        liveKitParticipants.delete(
            roomName
        );
    }
}

async function kickUserFromRoom(
    roomName,
    userId
) {
    if (
        !liveKitRoomService
    ) {
        console.warn(
            "LiveKit RoomService недоступен."
        );

        return;
    }

    const identities =
        getLiveKitIdentities(
            roomName,
            userId
        );

    if (
        identities.length === 0
    ) {
        return;
    }

    for (
        const identity
        of identities
    ) {
        try {
            await liveKitRoomService
                .removeParticipant(
                    roomName,
                    identity
                );

            console.log(
                `LiveKit kick: ${identity} из ${roomName}`
            );

        } catch (error) {
            console.warn(
                `Не удалось исключить ${identity} из ${roomName}:`,
                error.message
            );
        }

        removeTrackedIdentity(
            roomName,
            userId,
            identity
        );
    }
}

/* =========================
   LIVEKIT TOKEN
   ========================= */

app.get(
    "/api/livekit-token",
    async function (
        req,
        res
    ) {
        try {

            const room =
                req.query.room;

            if (!room) {
                return res.status(400).json({
                    error:
                        "Room is required"
                });
            }

            const userId =
                ensureUserId(
                    req,
                    res
                );

            const ban =
                getActiveBan(
                    userId
                );

            if (ban) {
                return res.status(403).json({
                    error:
                        "USER_BANNED",

                    reason:
                        ban.reason,

                    expiresAt:
                        ban.expiresAt
                });
            }

            const identity =
                "user-" +
                crypto
                    .randomBytes(8)
                    .toString(
                        "hex"
                    );

            const token =
                new AccessToken(
                    process.env.LIVEKIT_API_KEY,
                    process.env.LIVEKIT_API_SECRET,
                    {
                        identity:
                            identity
                    }
                );

            token.addGrant({
                roomJoin:
                    true,

                room:
                    room
            });

            const jwt =
                await token.toJwt();

            registerLiveKitParticipant(
                room,
                userId,
                identity
            );

            return res.json({
                token:
                    jwt,

                url:
                    process.env.LIVEKIT_URL,

                identity:
                    identity
            });

        } catch (error) {

            console.error(
                "LiveKit token error:",
                error
            );

            return res.status(500).json({
                error:
                    "Failed to create LiveKit token"
            });
        }
    }
);

/* =========================
   START MATCH
   ========================= */

app.post(
    "/api/match/start",
    async function (
        req,
        res
    ) {
        try {

            const userId =
                ensureUserId(
                    req,
                    res
                );

            const ban =
                getActiveBan(
                    userId
                );

            if (ban) {
                return res.status(403).json({
                    error:
                        "USER_BANNED",

                    reason:
                        ban.reason,

                    expiresAt:
                        ban.expiresAt
                });
            }

            const {
                socketId,
                gender,
                searchGender
            } = req.body;

            if (
                !socketId ||
                typeof socketId !==
                    "string"
            ) {
                return res.status(400).json({
                    error:
                        "socketId is required"
                });
            }

            if (
                !gender ||
                typeof gender !==
                    "string"
            ) {
                return res.status(400).json({
                    error:
                        "gender is required"
                });
            }

            const normalizedSearchGender =
                searchGender ===
                    "male" ||
                searchGender ===
                    "female"
                    ? searchGender
                    : "any";

            waitingUsers.delete(
                socketId
            );

            matches.delete(
                socketId
            );

            let matchedId =
                null;

            let matchedUser =
                null;

            for (
                const [
                    id,
                    user
                ]
                of waitingUsers
            ) {

                if (
                    id ===
                    socketId
                ) {
                    continue;
                }

                const firstWants =
                    normalizedSearchGender ===
                        "any" ||
                    normalizedSearchGender ===
                        user.gender;

                const secondWants =
                    user.searchGender ===
                        "any" ||
                    user.searchGender ===
                        gender;

                if (
                    !firstWants ||
                    !secondWants
                ) {
                    continue;
                }

                const otherBan =
                    getActiveBan(
                        user.userId
                    );

                if (otherBan) {
                    continue;
                }

                matchedId =
                    id;

                matchedUser =
                    user;

                break;
            }

            if (
                matchedId &&
                matchedUser
            ) {

                waitingUsers.delete(
                    matchedId
                );

                const roomName =
                    "icechat-" +
                    Date.now() +
                    "-" +
                    crypto
                        .randomBytes(4)
                        .toString(
                            "hex"
                        );

                const currentUserCountry =
                    await getCountry(
                        req
                    );

                matches.set(
                    matchedId,
                    {
                        roomName:
                            roomName,

                        peer: {
                            gender:
                                gender,

                            country:
                                currentUserCountry
                        }
                    }
                );

                const matchRoom = {
                    users: [
                        matchedId,
                        socketId
                    ],

                    userIds: [
                        matchedUser.userId,
                        userId
                    ],

                    sessionIds: [
                        matchedId,
                        socketId
                    ],

                    endedFor:
                        new Set()
                };

                matchRooms.set(
                    roomName,
                    matchRoom
                );

                return res.json({
                    status:
                        "matched",

                    roomName:
                        roomName,

                    peer: {
                        gender:
                            matchedUser.gender,

                        country:
                            matchedUser.country
                    }
                });
            }

            const country =
                await getCountry(
                    req
                );

            waitingUsers.set(
                socketId,
                {
                    userId:
                        userId,

                    socketId:
                        socketId,

                    gender:
                        gender,

                    searchGender:
                        normalizedSearchGender,

                    country:
                        country,

                    createdAt:
                        Date.now()
                }
            );

            return res.json({
                status:
                    "waiting"
            });

        } catch (error) {

            console.error(
                "Match start error:",
                error
            );

            return res.status(500).json({
                error:
                    "Match failed"
            });
        }
    }
);

/* =========================
   CHECK MATCH
   ========================= */

app.get(
    "/api/match/check",
    function (
        req,
        res
    ) {
        const socketId =
            req.query.socketId;

        if (!socketId) {
            return res.status(400).json({
                error:
                    "socketId is required"
            });
        }

        for (
            const [
                roomName,
                matchData
            ]
            of matchRooms
        ) {

            if (
                !matchData.users.includes(
                    socketId
                )
            ) {
                continue;
            }

            const otherUser =
                matchData.users.find(
                    function (id) {
                        return (
                            id !==
                            socketId
                        );
                    }
                );

            if (
                matchData.endedFor.has(
                    socketId
                )
            ) {
                return res.json({
                    status:
                        "ended"
                });
            }

            if (
                otherUser &&
                matchData.endedFor.has(
                    otherUser
                )
            ) {

                matchData.endedFor.add(
                    socketId
                );

                return res.json({
                    status:
                        "peerLeft"
                });
            }
        }

        const match =
            matches.get(
                socketId
            );

        if (!match) {
            return res.json({
                status:
                    "waiting"
            });
        }

        matches.delete(
            socketId
        );

        return res.json({
            status:
                "matched",

            roomName:
                match.roomName,

            peer:
                match.peer
        });
    }
);

/* =========================
   STOP MATCH
   ========================= */

app.post(
    "/api/match/stop",
    function (
        req,
        res
    ) {

        const {
            socketId
        } = req.body;

        if (!socketId) {
            return res.json({
                status:
                    "stopped"
            });
        }

        waitingUsers.delete(
            socketId
        );

        matches.delete(
            socketId
        );

        for (
            const [
                roomName,
                matchData
            ]
            of matchRooms
        ) {

            if (
                !matchData.users.includes(
                    socketId
                )
            ) {
                continue;
            }

            matchData.endedFor.add(
                socketId
            );

            if (
                matchData
                    .endedFor
                    .size >= 2
            ) {

                matchRooms.delete(
                    roomName
                );

                liveKitParticipants.delete(
                    roomName
                );
            }

            break;
        }

        return res.json({
            status:
                "stopped"
        });
    }
);

/* =========================
   REPORT
   ========================= */

app.post(
    "/api/report",
    function (
        req,
        res
    ) {

        try {

            const reporterId =
                getUserId(
                    req
                );

            if (!reporterId) {
                return res.status(400).json({
                    error:
                        "User identity missing"
                });
            }

            const {
                reason,
                details,
                roomName,
                chatHistory,
                evidenceImage,
                evidenceCapturedAt
            } = req.body;

            if (
                !reason ||
                typeof reason !==
                    "string"
            ) {
                return res.status(400).json({
                    error:
                        "Reason is required"
                });
            }

            if (
                !roomName ||
                typeof roomName !==
                    "string"
            ) {
                return res.status(400).json({
                    error:
                        "Room is required"
                });
            }

            const matchData =
                matchRooms.get(
                    roomName
                );

            if (!matchData) {
                return res.status(400).json({
                    error:
                        "Match no longer exists"
                });
            }

            const reporterIndex =
                matchData.userIds.indexOf(
                    reporterId
                );

            if (
                reporterIndex ===
                -1
            ) {
                return res.status(403).json({
                    error:
                        "You are not a member of this room"
                });
            }

            const targetIndex =
                reporterIndex === 0
                    ? 1
                    : 0;

            const targetUserId =
                matchData.userIds[
                    targetIndex
                ];

            const targetSessionId =
                matchData.sessionIds
                    ? matchData.sessionIds[
                        targetIndex
                    ]
                    : null;

            const cleanReason =
                reason
                    .trim()
                    .substring(
                        0,
                        200
                    );

            const cleanDetails =
                typeof details ===
                    "string"
                    ? details
                        .trim()
                        .substring(
                            0,
                            1000
                        )
                    : "";

            let safeChatHistory =
                [];

            if (
                Array.isArray(
                    chatHistory
                )
            ) {

                safeChatHistory =
                    chatHistory
                        .slice(0, 1000)
                        .map(
                            function (
                                item
                            ) {
                                return {

                                    side:
                                        item &&
                                        (
                                            item.side ===
                                                "Вы" ||
                                            item.side ===
                                                "Собеседник"
                                        )
                                            ? item.side
                                            : "Неизвестно",

                                    text:
                                        item &&
                                        typeof item.text ===
                                            "string"
                                            ? item.text.substring(
                                                0,
                                                1000
                                            )
                                            : "",

                                    timestamp:
                                        item &&
                                        item.timestamp
                                            ? String(
                                                item.timestamp
                                            )
                                            : null
                                };
                            }
                        );
            }

            let safeEvidenceImage =
                null;

            if (
                typeof evidenceImage ===
                    "string" &&
                evidenceImage.startsWith(
                    "data:image/"
                )
            ) {

                if (
                    evidenceImage.length <=
                    3000000
                ) {
                    safeEvidenceImage =
                        evidenceImage;
                }
            }

            const reports =
                readReports();

            const duplicate =
                reports.find(
                    function (
                        report
                    ) {
                        return (
                            report.reporterId ===
                                reporterId &&
                            report.targetUserId ===
                                targetUserId &&
                            report.roomName ===
                                roomName &&
                            report.status ===
                                "new"
                        );
                    }
                );

            if (duplicate) {
                return res.json({
                    status:
                        "ok",

                    reportId:
                        duplicate.id
                });
            }

            const report = {

                id:
                    randomId(
                        "report_"
                    ),

                reason:
                    cleanReason,

                details:
                    cleanDetails,

                reporterId:
                    reporterId,

                targetUserId:
                    targetUserId,

                targetSessionId:
                    targetSessionId,

                roomName:
                    roomName,

                status:
                    "new",

                adminNote:
                    "",

                createdAt:
                    new Date()
                        .toISOString(),

                reviewedAt:
                    null,

                evidenceCapturedAt:
                    evidenceCapturedAt
                        ? String(
                            evidenceCapturedAt
                        )
                        : null,

                evidenceImage:
                    safeEvidenceImage,

                chatHistory:
                    safeChatHistory
            };

            reports.push(
                report
            );

            writeReports(
                reports
            );

            console.log(
                "Новая жалоба:",
                report.id
            );

            return res.json({
                status:
                    "ok",

                reportId:
                    report.id
            });

        } catch (error) {

            console.error(
                "Report error:",
                error
            );

            return res.status(500).json({
                error:
                    "Failed to save report"
            });
        }
    }
);

/* =========================
   ADMIN LOGIN
   ========================= */

app.post(
    "/api/admin/login",
    function (
        req,
        res
    ) {

        if (!ADMIN_PASSWORD) {
            return res.status(500).json({
                error:
                    "ADMIN_PASSWORD is not configured"
            });
        }

        const password =
            typeof req.body.password ===
                "string"
                ? req.body.password
                : "";

        if (
            password !==
            ADMIN_PASSWORD
        ) {
            return res.status(401).json({
                error:
                    "Неверный пароль"
            });
        }

        const sessionId =
            randomId(
                "adm_"
            );

        adminSessions.set(
            sessionId,
            {
                createdAt:
                    Date.now()
            }
        );

        setCookie(
            res,
            "icechat_admin",
            sessionId,
            {
                httpOnly:
                    true,

                sameSite:
                    "Strict",

                maxAge:
                    60 *
                    60 *
                    12
            }
        );

        return res.json({
            status:
                "ok"
        });
    }
);

/* =========================
   ADMIN LOGOUT
   ========================= */

app.post(
    "/api/admin/logout",
    requireAdmin,
    function (
        req,
        res
    ) {

        const cookies =
            parseCookies(req);

        adminSessions.delete(
            cookies.icechat_admin
        );

        clearCookie(
            res,
            "icechat_admin"
        );

        return res.json({
            status:
                "ok"
        });
    }
);

/* =========================
   ADMIN ME
   ========================= */

app.get(
    "/api/admin/me",
    requireAdmin,
    function (
        req,
        res
    ) {

        return res.json({
            status:
                "ok"
        });
    }
);

/* =========================
   ADMIN REPORTS
   ========================= */

app.get(
    "/api/admin/reports",
    requireAdmin,
    function (
        req,
        res
    ) {

        const reports =
            readReports();

        reports.sort(
            function (
                a,
                b
            ) {

                return (
                    new Date(
                        b.createdAt ||
                        0
                    ).getTime() -
                    new Date(
                        a.createdAt ||
                        0
                    ).getTime()
                );
            }
        );

        return res.json({
            reports:
                reports
        });
    }
);

/* =========================
   ADMIN REPORT ACTION
   ========================= */

app.post(
    "/api/admin/reports/:reportId/action",
    requireAdmin,
    async function (
        req,
        res
    ) {

        try {

            const reportId =
                req.params.reportId;

            const {
                action,
                note,
                duration
            } = req.body;

            const reports =
                readReports();

            const report =
                reports.find(
                    function (
                        item
                    ) {
                        return (
                            item.id ===
                            reportId
                        );
                    }
                );

            if (!report) {
                return res.status(404).json({
                    error:
                        "Report not found"
                });
            }

            const cleanNote =
                typeof note ===
                    "string"
                    ? note
                        .trim()
                        .substring(
                            0,
                            1000
                        )
                    : "";

            /* =========================
               REJECT
               ========================= */

            if (
                action ===
                "reject"
            ) {

                report.status =
                    "rejected";

                report.adminNote =
                    cleanNote;

                report.reviewedAt =
                    new Date()
                        .toISOString();

                writeReports(
                    reports
                );

                return res.json({
                    status:
                        "ok"
                });
            }

            /* =========================
               WARNING
               ========================= */

            if (
                action ===
                "warn"
            ) {

                report.status =
                    "warning";

                report.adminNote =
                    cleanNote;

                report.reviewedAt =
                    new Date()
                        .toISOString();

                writeReports(
                    reports
                );

                return res.json({
                    status:
                        "ok"
                });
            }

            /* =========================
               BAN
               ========================= */

            if (
                action ===
                "ban"
            ) {

                if (
                    !report.targetUserId
                ) {
                    return res.status(400).json({
                        error:
                            "В этой старой жалобе нет ID нарушителя. Новые жалобы будут содержать его автоматически."
                    });
                }

                const bans =
                    readBans();

                const existingIndex =
                    bans.findIndex(
                        function (
                            ban
                        ) {
                            return (
                                ban.userId ===
                                report.targetUserId
                            );
                        }
                    );

                /*
                 * Поддерживаем:
                 *
                 * minute   = 1 минута
                 * 1day     = 1 день
                 * 3days    = 3 дня
                 * 7days    = 7 дней
                 * 30days   = 30 дней
                 * permanent = навсегда
                 *
                 * Старое значение "24"
                 * тоже оставляем для совместимости.
                 */

                let expiresAt =
                    null;

                if (
                    duration ===
                    "minute"
                ) {

                    expiresAt =
                        new Date(
                            Date.now() +
                            60 *
                            1000
                        ).toISOString();

                } else if (
                    duration ===
                    "1day" ||
                    duration ===
                    "24"
                ) {

                    expiresAt =
                        new Date(
                            Date.now() +
                            1 *
                            24 *
                            60 *
                            60 *
                            1000
                        ).toISOString();

                } else if (
                    duration ===
                    "3days"
                ) {

                    expiresAt =
                        new Date(
                            Date.now() +
                            3 *
                            24 *
                            60 *
                            60 *
                            1000
                        ).toISOString();

                } else if (
                    duration ===
                    "7days"
                ) {

                    expiresAt =
                        new Date(
                            Date.now() +
                            7 *
                            24 *
                            60 *
                            60 *
                            1000
                        ).toISOString();

                } else if (
                    duration ===
                    "30days"
                ) {

                    expiresAt =
                        new Date(
                            Date.now() +
                            30 *
                            24 *
                            60 *
                            60 *
                            1000
                        ).toISOString();

                } else if (
                    duration ===
                    "permanent"
                ) {

                    expiresAt =
                        null;

                } else if (
                    typeof duration ===
                        "number"
                ) {

                    if (
                        !Number.isFinite(
                            duration
                        ) ||
                        duration <= 0
                    ) {
                        return res.status(400).json({
                            error:
                                "Invalid ban duration"
                        });
                    }

                    expiresAt =
                        new Date(
                            Date.now() +
                            duration *
                            60 *
                            60 *
                            1000
                        ).toISOString();

                } else {

                    /*
                     * Если что-то неизвестное,
                     * безопасно используем
                     * бан на 1 день.
                     */

                    expiresAt =
                        new Date(
                            Date.now() +
                            1 *
                            24 *
                            60 *
                            60 *
                            1000
                        ).toISOString();
                }

                const ban = {

                    userId:
                        report.targetUserId,

                    reason:
                        report.reason,

                    adminNote:
                        cleanNote,

                    createdAt:
                        new Date()
                            .toISOString(),

                    expiresAt:
                        expiresAt
                };

                if (
                    existingIndex !==
                    -1
                ) {

                    bans[
                        existingIndex
                    ] = ban;

                } else {

                    bans.push(
                        ban
                    );
                }

                writeBans(
                    bans
                );

                report.status =
                    "banned";

                report.adminNote =
                    cleanNote;

                report.reviewedAt =
                    new Date()
                        .toISOString();

                writeReports(
                    reports
                );

                /* =========================
                   УДАЛЯЕМ ИЗ ОЧЕРЕДИ
                   ========================= */

                for (
                    const [
                        socketId,
                        user
                    ]
                        of waitingUsers
                ) {

                    if (
                        user.userId ===
                        report.targetUserId
                    ) {

                        waitingUsers.delete(
                            socketId
                        );

                        matches.delete(
                            socketId
                        );
                    }
                }

                /* =========================
                   KICK ИЗ LIVEKIT
                   ========================= */

                let kickedCount =
                    0;

                for (
                    const [
                        roomName,
                        matchData
                    ]
                        of matchRooms
                ) {

                    if (
                        !matchData.userIds ||
                        !matchData.userIds.includes(
                            report.targetUserId
                        )
                    ) {
                        continue;
                    }

                    await kickUserFromRoom(
                        roomName,
                        report.targetUserId
                    );

                    const targetIndex =
                        matchData.userIds
                            .indexOf(
                                report.targetUserId
                            );

                    if (
                        targetIndex !==
                        -1
                    ) {

                        const targetSocket =
                            matchData.users[
                                targetIndex
                            ];

                        if (
                            targetSocket
                        ) {
                            matchData.endedFor.add(
                                targetSocket
                            );

                            kickedCount++;
                        }
                    }

                    /*
                     * Второй участник обнаружит
                     * peerLeft через /api/match/check.
                     */
                }

                return res.json({
                    status:
                        "ok",

                    ban:
                        ban,

                    kickedRooms:
                        kickedCount
                });
            }

            return res.status(400).json({
                error:
                    "Unknown action"
            });

        } catch (error) {

            console.error(
                "Admin report action error:",
                error
            );

            return res.status(500).json({
                error:
                    "Failed to process report"
            });
        }
    }
);

/* =========================
   ADMIN BANS
   ========================= */

app.get(
    "/api/admin/bans",
    requireAdmin,
    function (
        req,
        res
    ) {

        const bans =
            readBans();

        const now =
            Date.now();

        const activeBans =
            bans.filter(
                function (
                    ban
                ) {

                    if (
                        ban.expiresAt &&
                        new Date(
                            ban.expiresAt
                        ).getTime() <=
                        now
                    ) {
                        return false;
                    }

                    return true;
                }
            );

        if (
            activeBans.length !==
            bans.length
        ) {
            writeBans(
                activeBans
            );
        }

        return res.json({
            bans:
                activeBans
        });
    }
);

/* =========================
   ADMIN UNBAN
   ========================= */

app.post(
    "/api/admin/bans/:userId/unban",
    requireAdmin,
    function (
        req,
        res
    ) {

        const userId =
            req.params.userId;

        const bans =
            readBans();

        const updated =
            bans.filter(
                function (
                    ban
                ) {
                    return (
                        ban.userId !==
                        userId
                    );
                }
            );

        writeBans(
            updated
        );

        return res.json({
            status:
                "ok"
        });
    }
);

/* =========================
   ADMIN PAGE
   ========================= */

app.get(
    "/admin",
    function (
        req,
        res
    ) {

        return res.sendFile(
            path.join(
                __dirname,
                "public",
                "admin.html"
            )
        );
    }
);

/* =========================
   STATUS
   ========================= */

app.get(
    "/api/match/status",
    function (
        req,
        res
    ) {

        return res.json({

            waiting:
                waitingUsers.size,

            matches:
                matches.size,

            rooms:
                matchRooms.size,

            livekitRooms:
                liveKitParticipants.size
        });
    }
);

/* =========================
   CLEANUP
   ========================= */

setInterval(
    function () {

        const now =
            Date.now();

        const MAX_WAIT =
            2 *
            60 *
            1000;

        for (
            const [
                socketId,
                user
            ]
                of waitingUsers
        ) {

            if (
                !user.createdAt ||
                now -
                    user.createdAt >
                    MAX_WAIT
            ) {

                waitingUsers.delete(
                    socketId
                );

                matches.delete(
                    socketId
                );
            }
        }

    },
    30 *
    1000
);

/*
 * Дополнительная очистка
 * старых LiveKit записей.
 */

setInterval(
    function () {

        for (
            const [
                roomName
            ]
                of liveKitParticipants
        ) {

            if (
                !matchRooms.has(
                    roomName
                )
            ) {

                liveKitParticipants.delete(
                    roomName
                );
            }
        }

    },
    60 *
    1000
);

/* =========================
   SERVER
   ========================= */

server.listen(
    PORT,
    "0.0.0.0",
    function () {

        console.log(
            `IceChat запущен на порту ${PORT}`
        );

        if (
            !ADMIN_PASSWORD
        ) {

            console.warn(
                "ВНИМАНИЕ: ADMIN_PASSWORD не задан в .env"
            );
        }

        if (
            liveKitRoomService
        ) {

            console.log(
                "LiveKit moderation: ON"
            );

        } else {

            console.warn(
                "ВНИМАНИЕ: LiveKit moderation OFF — проверь LIVEKIT_URL/API KEY/SECRET"
            );
        }

        console.log(
            "Матчинг: userId + socketId"
        );

        console.log(
            "Баны: 1м / 1д / 3д / 7д / 30д / навсегда"
        );
    }
);