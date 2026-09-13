document.addEventListener("DOMContentLoaded", function () {
    console.log("ICECHAT APP START");

    if (!window.LivekitClient) {
        console.error("LiveKit Client не загрузился");
        return;
    }

    var Room = LivekitClient.Room;
    var RoomEvent = LivekitClient.RoomEvent;
    var Track = LivekitClient.Track;
    var createLocalVideoTrack = LivekitClient.createLocalVideoTrack;
    var createLocalAudioTrack = LivekitClient.createLocalAudioTrack;

    var statusEl = document.getElementById("status");

    var joinButton = document.getElementById("joinButton");
    var leaveButton = document.getElementById("leaveButton");
    var micButton = document.getElementById("micButton");
    var cameraButton = document.getElementById("cameraButton");

    var localVideo = document.getElementById("localVideo");
    var remoteVideo = document.getElementById("remoteVideo");

    var remotePlaceholder = document.getElementById("remotePlaceholder");
    var remoteInfo = document.getElementById("remoteInfo");
    var remoteGender = document.getElementById("remoteGender");
    var remoteCountry = document.getElementById("remoteCountry");

    var myGender = null;
    var searchGender = "any";

    var socketId = null;
    var room = null;

    var localVideoTrack = null;
    var localAudioTrack = null;

    var searching = false;
    var connected = false;
    var checkTimer = null;

    var remoteAudioElements = [];

    function setStatus(text) {
        if (statusEl) {
            statusEl.textContent = text;
        }
    }

    function getFlag(code) {
        if (!code) {
            return "🌐";
        }

        code = String(code).toUpperCase();

        if (code.length !== 2) {
            return "🌐";
        }

        return String.fromCodePoint(127397 + code.charCodeAt(0)) +
               String.fromCodePoint(127397 + code.charCodeAt(1));
    }

    function showPeerInfo(peer) {
        if (!peer) {
            return;
        }

        if (remoteInfo) {
            remoteInfo.classList.remove("hidden");
        }

        if (remoteGender) {
            if (peer.gender === "male") {
                remoteGender.textContent = "♂ Мужчина";
            } else if (peer.gender === "female") {
                remoteGender.textContent = "♀ Женщина";
            } else {
                remoteGender.textContent = "👤 Собеседник";
            }
        }

        var code = "UN";

        if (peer.country) {
            if (typeof peer.country === "object") {
                code =
                    peer.country.code ||
                    peer.country.countryCode ||
                    "UN";
            } else {
                code = peer.country;
            }
        }

        if (remoteCountry) {
            code = String(code).toUpperCase();
            remoteCountry.textContent = getFlag(code) + " " + code;
        }
    }

    function hidePeerInfo() {
        if (remoteInfo) {
            remoteInfo.classList.add("hidden");
        }
    }

    /*
     * =========================
     * ТОЛЬКО СУЩЕСТВУЮЩЕЕ
     * REMOTE VIDEO
     * =========================
     */
    function attachRemoteVideo(track) {
        if (!track || !remoteVideo) {
            return;
        }

        try {
            track.attach(remoteVideo);

            remoteVideo.autoplay = true;
            remoteVideo.playsInline = true;

            if (remotePlaceholder) {
                remotePlaceholder.style.display = "none";
            }

            var playPromise = remoteVideo.play();

            if (playPromise && playPromise.catch) {
                playPromise.catch(function () {});
            }

            console.log("REMOTE VIDEO ATTACHED");
        } catch (error) {
            console.error("Remote video error:", error);
        }
    }

    /*
     * =========================
     * ТОЛЬКО СУЩЕСТВУЮЩЕЕ
     * LOCAL VIDEO
     * =========================
     */
    function attachLocalVideo(track) {
        if (!track || !localVideo) {
            return;
        }

        try {
            track.attach(localVideo);

            localVideo.autoplay = true;
            localVideo.muted = true;
            localVideo.playsInline = true;

            var playPromise = localVideo.play();

            if (playPromise && playPromise.catch) {
                playPromise.catch(function () {});
            }

            console.log("LOCAL VIDEO ATTACHED");
        } catch (error) {
            console.error("Local video error:", error);
        }
    }

    /*
     * =========================
     * AUDIO БЕЗ СОЗДАНИЯ VIDEO
     * =========================
     */
    function attachRemoteAudio(track) {
        if (!track) {
            return;
        }

        try {
            var audio = document.createElement("audio");

            audio.autoplay = true;
            audio.playsInline = true;

            track.attach(audio);

            document.body.appendChild(audio);

            remoteAudioElements.push(audio);

            var playPromise = audio.play();

            if (playPromise && playPromise.catch) {
                playPromise.catch(function () {});
            }

            console.log("REMOTE AUDIO ATTACHED");
        } catch (error) {
            console.error("Remote audio error:", error);
        }
    }

    function removeRemoteAudio() {
        for (var i = 0; i < remoteAudioElements.length; i++) {
            var audio = remoteAudioElements[i];

            try {
                audio.pause();
            } catch (error) {}

            try {
                audio.remove();
            } catch (error) {}
        }

        remoteAudioElements = [];
    }

    function clearVideoElements() {
        if (localVideo) {
            try {
                localVideo.srcObject = null;
            } catch (error) {}
        }

        if (remoteVideo) {
            try {
                remoteVideo.srcObject = null;
            } catch (error) {}
        }

        if (remotePlaceholder) {
            remotePlaceholder.style.display = "flex";
        }

        hidePeerInfo();
        removeRemoteAudio();
    }

    function updateButtons() {
        if (joinButton) {
            joinButton.disabled = searching || connected;
        }

        if (leaveButton) {
            leaveButton.disabled = !searching && !connected;
        }

        if (micButton) {
            micButton.disabled = !connected;
        }

        if (cameraButton) {
            cameraButton.disabled = !connected;
        }
    }

    /*
     * =========================
     * МОЙ ПОЛ
     * =========================
     */
    var myGenderButtons =
        document.querySelectorAll("[data-my-gender]");

    for (var i = 0; i < myGenderButtons.length; i++) {
        myGenderButtons[i].addEventListener("click", function () {

            myGender =
                this.getAttribute("data-my-gender");

            for (var j = 0; j < myGenderButtons.length; j++) {
                myGenderButtons[j].classList.remove("selected");
            }

            this.classList.add("selected");

            console.log("MY GENDER:", myGender);
        });
    }

    /*
     * =========================
     * ПОЛ СОБЕСЕДНИКА
     * =========================
     */
    var searchGenderButtons =
        document.querySelectorAll("[data-search-gender]");

    for (var k = 0; k < searchGenderButtons.length; k++) {
        searchGenderButtons[k].addEventListener("click", function () {

            searchGender =
                this.getAttribute("data-search-gender");

            for (var l = 0; l < searchGenderButtons.length; l++) {
                searchGenderButtons[l].classList.remove("selected");
            }

            this.classList.add("selected");

            console.log(
                "SEARCH GENDER:",
                searchGender
            );
        });
    }

    /*
     * =========================
     * LIVEKIT
     * =========================
     */
    async function connectToRoom(roomName, peer) {
        try {
            setStatus("Подключение...");

            var tokenResponse =
                await fetch(
                    "/api/livekit-token?room=" +
                    encodeURIComponent(roomName)
                );

            if (!tokenResponse.ok) {
                throw new Error(
                    "LiveKit token error"
                );
            }

            var tokenData =
                await tokenResponse.json();

            room = new Room({
                adaptiveStream: true,
                dynacast: true
            });

            /*
             * Новый video track
             */
            room.on(
                RoomEvent.TrackSubscribed,
                function (track, publication, participant) {

                    console.log(
                        "TRACK SUBSCRIBED:",
                        track.kind
                    );

                    if (track.kind === Track.Kind.Video) {
                        attachRemoteVideo(track);
                    }

                    if (track.kind === Track.Kind.Audio) {
                        attachRemoteAudio(track);
                    }
                }
            );

            /*
             * Track убрали
             */
            room.on(
                RoomEvent.TrackUnsubscribed,
                function (track) {

                    try {
                        track.detach();
                    } catch (error) {}
                }
            );

            /*
             * Собеседник подключился
             */
            room.on(
                RoomEvent.ParticipantConnected,
                function (participant) {

                    console.log(
                        "PARTICIPANT CONNECTED:",
                        participant.identity
                    );

                    participant.trackPublications.forEach(
                        function (publication) {

                            if (!publication.track) {
                                return;
                            }

                            if (
                                publication.track.kind ===
                                Track.Kind.Video
                            ) {
                                attachRemoteVideo(
                                    publication.track
                                );
                            }

                            if (
                                publication.track.kind ===
                                Track.Kind.Audio
                            ) {
                                attachRemoteAudio(
                                    publication.track
                                );
                            }
                        }
                    );
                }
            );

            /*
             * LiveKit disconnect
             */
            room.on(
                RoomEvent.Disconnected,
                function () {

                    console.log(
                        "LIVEKIT DISCONNECTED"
                    );

                    connected = false;
                    searching = false;

                    clearVideoElements();

                    setStatus(
                        "Соединение завершено"
                    );

                    updateButtons();
                }
            );

            await room.connect(
                tokenData.url,
                tokenData.token
            );

            console.log(
                "LIVEKIT CONNECTED"
            );

            /*
             * МОЯ КАМЕРА
             */
            localVideoTrack =
                await createLocalVideoTrack();

            /*
             * МОЙ МИКРОФОН
             */
            localAudioTrack =
                await createLocalAudioTrack();

            /*
             * Публикуем камеру
             */
            await room.localParticipant.publishTrack(
                localVideoTrack
            );

            /*
             * Публикуем микрофон
             */
            await room.localParticipant.publishTrack(
                localAudioTrack
            );

            /*
             * Показываем МОЮ камеру
             */
            attachLocalVideo(
                localVideoTrack
            );

            /*
             * Подхватываем уже существующего собеседника
             */
            room.remoteParticipants.forEach(
                function (participant) {

                    participant.trackPublications.forEach(
                        function (publication) {

                            if (!publication.track) {
                                return;
                            }

                            if (
                                publication.track.kind ===
                                Track.Kind.Video
                            ) {
                                attachRemoteVideo(
                                    publication.track
                                );
                            }

                            if (
                                publication.track.kind ===
                                Track.Kind.Audio
                            ) {
                                attachRemoteAudio(
                                    publication.track
                                );
                            }
                        }
                    );
                }
            );

            connected = true;
            searching = false;

            showPeerInfo(peer);

            setStatus(
                "Собеседник подключён"
            );

            updateButtons();

        } catch (error) {

            console.error(
                "LIVEKIT ERROR:",
                error
            );

            connected = false;
            searching = false;

            clearVideoElements();

            setStatus(
                "Ошибка подключения"
            );

            updateButtons();
        }
    }

    /*
     * =========================
     * НАЧАТЬ ПОИСК
     * =========================
     */
    async function startSearch() {

        if (searching || connected) {
            return;
        }

        if (!myGender) {
            setStatus(
                "Сначала выберите свой пол"
            );
            return;
        }

        searching = true;

        clearVideoElements();
        updateButtons();

        setStatus(
            "Поиск собеседника..."
        );

        socketId =
            "ice_" +
            Date.now() +
            "_" +
            Math.random()
                .toString(36)
                .substring(2, 10);

        try {

            var response =
                await fetch(
                    "/api/match/start",
                    {
                        method: "POST",
                        headers: {
                            "Content-Type":
                                "application/json"
                        },
                        body: JSON.stringify({
                            socketId: socketId,
                            gender: myGender,
                            searchGender: searchGender
                        })
                    }
                );

            if (!response.ok) {
                throw new Error(
                    "Match start error"
                );
            }

            var data =
                await response.json();

            console.log(
                "MATCH START:",
                data
            );

            if (
                data.matched &&
                data.roomName
            ) {

                await connectToRoom(
                    data.roomName,
                    data.peer || null
                );

                return;
            }

            if (checkTimer) {
                clearInterval(checkTimer);
            }

            checkTimer =
                setInterval(
                    checkMatch,
                    1000
                );

        } catch (error) {

            console.error(
                "MATCH ERROR:",
                error
            );

            searching = false;

            setStatus(
                "Ошибка поиска"
            );

            updateButtons();
        }
    }

    /*
     * =========================
     * ПРОВЕРКА СОБЕСЕДНИКА
     * =========================
     */
    async function checkMatch() {

        if (!searching || !socketId) {
            return;
        }

        try {

            var response =
                await fetch(
                    "/api/match/check?socketId=" +
                    encodeURIComponent(socketId)
                );

            if (!response.ok) {
                return;
            }

            var data =
                await response.json();

            console.log(
                "MATCH CHECK:",
                data
            );

            if (
                data.matched &&
                data.roomName
            ) {

                if (checkTimer) {
                    clearInterval(checkTimer);
                    checkTimer = null;
                }

                await connectToRoom(
                    data.roomName,
                    data.peer || null
                );
            }

        } catch (error) {

            console.error(
                "CHECK ERROR:",
                error
            );
        }
    }

    /*
     * =========================
     * STOP
     * =========================
     */
    async function stopEverything() {

        if (checkTimer) {
            clearInterval(checkTimer);
            checkTimer = null;
        }

        searching = false;

        try {

            if (socketId) {

                await fetch(
                    "/api/match/stop",
                    {
                        method: "POST",
                        headers: {
                            "Content-Type":
                                "application/json"
                        },
                        body: JSON.stringify({
                            socketId: socketId
                        })
                    }
                );
            }

        } catch (error) {

            console.error(
                "STOP REQUEST ERROR:",
                error
            );
        }

        if (room) {

            try {
                room.disconnect();
            } catch (error) {}

            room = null;
        }

        if (localVideoTrack) {

            try {
                localVideoTrack.stop();
            } catch (error) {}

            localVideoTrack = null;
        }

        if (localAudioTrack) {

            try {
                localAudioTrack.stop();
            } catch (error) {}

            localAudioTrack = null;
        }

        connected = false;
        socketId = null;

        clearVideoElements();

        setStatus(
            "Готов к поиску"
        );

        updateButtons();
    }

    /*
     * =========================
     * МИКРОФОН
     * =========================
     */
    if (micButton) {

        micButton.addEventListener(
            "click",
            async function () {

                if (!localAudioTrack) {
                    return;
                }

                try {

                    var enabled =
                        localAudioTrack.isEnabled;

                    await localAudioTrack.enable(
                        !enabled
                    );

                    if (enabled) {
                        micButton.textContent =
                            "🔇 Микрофон";
                    } else {
                        micButton.textContent =
                            "🎤 Микрофон";
                    }

                } catch (error) {

                    console.error(
                        "MIC ERROR:",
                        error
                    );
                }
            }
        );
    }

    /*
     * =========================
     * КАМЕРА
     * =========================
     */
    if (cameraButton) {

        cameraButton.addEventListener(
            "click",
            async function () {

                if (!localVideoTrack) {
                    return;
                }

                try {

                    var enabled =
                        localVideoTrack.isEnabled;

                    await localVideoTrack.enable(
                        !enabled
                    );

                    if (enabled) {
                        cameraButton.textContent =
                            "🚫 Камера";
                    } else {
                        cameraButton.textContent =
                            "📷 Камера";
                    }

                } catch (error) {

                    console.error(
                        "CAMERA ERROR:",
                        error
                    );
                }
            }
        );
    }

    /*
     * =========================
     * НАЙТИ СОБЕСЕДНИКА
     * =========================
     */
    if (joinButton) {

        joinButton.addEventListener(
            "click",
            function () {
                startSearch();
            }
        );
    }

    /*
     * =========================
     * STOP
     * =========================
     */
    if (leaveButton) {

        leaveButton.addEventListener(
            "click",
            function () {
                stopEverything();
            }
        );
    }

    /*
     * =========================
     * СТАРТ
     * =========================
     */
    updateButtons();

    setStatus(
        "Готов к поиску"
    );

    console.log(
        "IceChat app.js loaded successfully"
    );
});