document.addEventListener('DOMContentLoaded', () => {
    const isObs = navigator.userAgent.includes('OBS');
    
    // Global Variables
    let audioContext;
    let soundsData = { se: [], bgm: [] };
    let bufferCache = {};
    let ws = null;
    let globalSettings = {
        masterVolume: 1,
        columns: 5,
        bgmColumns: 1,
        fadeTime: 2.0,
        playOnRemote: false,
        themeColor: '#3ea6ff',
        customBgmSlots: [],
        seFolder: 'SE',
        bgmFolder: 'BGM'
    };
    
    // BGM State
    let currentBgmSource = null;
    let currentBgmGain = null;
    let currentBgmId = null;
    let currentBgmBuffer = null;
    let currentBgmStartTime = 0;
    let currentBgmPauseTime = 0;
    let isBgmPlaying = false;
    let isBgmLoop = true;

    // SE State
    let activeSeSources = [];
    
    // UI State
    let isSeeking = false;
    let bgmTimer = null;
    let reservationQueue = [];

    // --- WebSocket Connection ---
    function connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${window.location.host}`);

        ws.onopen = () => {
            console.log('Connected to WebSocket server');
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                handleRemoteCommand(msg);
            } catch (e) {
                console.error('Invalid message:', event.data);
            }
        };

        ws.onclose = () => {
            console.log('Disconnected. Reconnecting...');
            setTimeout(connectWebSocket, 3000);
        };
    }

    function sendCommand(cmd) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(cmd));
        }
    }

    // --- Remote Command Handler (音量連動を追加) ---
    function handleRemoteCommand(msg) {
        if (msg.type === 'play') {
            const sound = [...soundsData.se, ...soundsData.bgm].find(s => s.id === msg.id);
            if (sound) {
                playSoundFile(sound, msg.catType, globalSettings.fadeTime, true);
            }
        } else if (msg.type === 'stopBgm') {
            stopBgm(msg.fade);
        } else if (msg.type === 'stopSe') {
            stopAllSe();
        } else if (msg.type === 'volume') {
            // ★追加: 音量連動ロジック
            if (msg.target === 'master') {
                const el = document.getElementById('master-volume');
                if (el) {
                    el.value = msg.value;
                    updateSliderBackground(el);
                    globalSettings.masterVolume = parseFloat(msg.value);
                    // 再生中のBGM音量を即時更新
                    if (currentBgmGain) {
                        const bgmVol = document.getElementById('bgm-volume').value;
                        currentBgmGain.gain.setTargetAtTime(bgmVol * globalSettings.masterVolume, audioContext.currentTime, 0.1);
                    }
                }
            } else if (msg.target === 'bgm') {
                const el = document.getElementById('bgm-volume');
                if (el) {
                    el.value = msg.value;
                    updateSliderBackground(el);
                    // 再生中のBGM音量を即時更新
                    if (currentBgmGain) {
                        currentBgmGain.gain.setTargetAtTime(msg.value * globalSettings.masterVolume, audioContext.currentTime, 0.1);
                    }
                }
            } else if (msg.target === 'se') {
                // SE個別音量の連動
                // data-se-id 属性を使って該当のスライダーを探す
                const slider = [...document.querySelectorAll('.volume-slider')].find(el => el.dataset.seId === msg.id);
                if (slider) {
                    slider.value = msg.value;
                    updateSliderBackground(slider);
                    
                    // 設定保存
                    if (!globalSettings.sounds) globalSettings.sounds = {};
                    if (!globalSettings.sounds[msg.id]) globalSettings.sounds[msg.id] = {};
                    globalSettings.sounds[msg.id].volume = parseFloat(msg.value);
                }
            }
        }
    }

    // --- Notifications ---
    function showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification`;
        notification.textContent = message;
        
        let bg;
        if(type === 'error') bg = 'linear-gradient(135deg, #ff4e45 0%, #d32f2f 100%)';
        else if(type === 'success') bg = 'linear-gradient(135deg, #2ba640 0%, #1e7e34 100%)';
        else bg = 'linear-gradient(135deg, var(--accent-color) 0%, var(--accent-hover) 100%)';
        
        notification.style.background = bg;
        notification.style.position = 'fixed'; notification.style.top = '20px'; notification.style.right = '20px';
        notification.style.padding = '12px 20px'; notification.style.borderRadius = '8px'; notification.style.color = 'white';
        notification.style.fontWeight = 'bold'; notification.style.boxShadow = '0 4px 10px rgba(0,0,0,0.3)'; notification.style.zIndex = '10000';
        
        document.body.appendChild(notification);
        setTimeout(() => { 
            notification.style.opacity = '0'; 
            notification.style.transition = 'opacity 0.3s';
            setTimeout(() => notification.remove(), 300); 
        }, 3000);
    }

    // --- Audio Engine ---
    async function initAudio() {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            if (audioContext.state === 'suspended') await audioContext.resume();
        }
    }

    // Fetch Data from Server
    async function loadSounds() {
        try {
            const response = await fetch('/sounds');
            const data = await response.json();
            processSoundsData(data);
        } catch (e) {
            console.error("Failed to fetch sounds:", e);
            showNotification('サウンド一覧の取得に失敗しました', 'error');
        }
    }

    function processSoundsData(data) {
        soundsData.se = [];
        soundsData.bgm = [];
        
        const processFile = (file, category) => {
            const id = `sound-${category ? category + '-' : ''}${file.name}`;
            return {
                id: id,
                name: file.name,
                path: file.path,
                category: category || '未分類'
            };
        };

        Object.keys(data.categories || {}).forEach(cat => {
            data.categories[cat].forEach(file => {
                const sound = processFile(file, cat);
                const lowerCat = cat.toLowerCase();
                const bgmTarget = globalSettings.bgmFolder.toLowerCase();
                const seTarget = globalSettings.seFolder.toLowerCase();
                
                if (lowerCat.includes(bgmTarget)) {
                    soundsData.bgm.push(sound);
                } else if (lowerCat.includes(seTarget)) {
                    soundsData.se.push(sound);
                } else {
                    soundsData.se.push(sound);
                }
            });
        });

        (data.files || []).forEach(file => {
            soundsData.se.push(processFile(file, null));
        });
        
        renderTabs();
    }

    function fetchMetadata(sound, elementId) {
        if (typeof jsmediatags === 'undefined') return;
        const el = document.getElementById(elementId);
        if(!el) return;
        const titleEl = el.querySelector('.bgm-title');
        const artistEl = el.querySelector('.bgm-artist');
        const artEl = el.querySelector('.bgm-art');

        jsmediatags.read(sound.path, {
            onSuccess: function(tag) {
                const tags = tag.tags;
                if(tags.title) titleEl.textContent = tags.title;
                if(tags.artist) artistEl.textContent = tags.artist;
                if(tags.picture) {
                    const { data, format } = tags.picture;
                    let base64String = "";
                    for (let i = 0; i < data.length; i++) { base64String += String.fromCharCode(data[i]); }
                    const base64 = "data:" + format + ";base64," + window.btoa(base64String);
                    artEl.style.backgroundImage = `url(${base64})`;
                    artEl.textContent = ''; 
                }
            },
            onError: function(error) {}
        });
    }

    async function playSoundFile(sound, type, fadeTime = 0, isRemoteOrigin = false) {
        // リモコンモードの判定
        if (!isObs && !globalSettings.playOnRemote && !isRemoteOrigin) {
            sendCommand({ type: 'play', id: sound.id, catType: type });
            return; 
        }

        await initAudio();
        try {
            let buffer;
            if (bufferCache[sound.id]) {
                buffer = bufferCache[sound.id];
            } else {
                const response = await fetch(sound.path);
                const arrayBuffer = await response.arrayBuffer();
                buffer = await audioContext.decodeAudioData(arrayBuffer);
                bufferCache[sound.id] = buffer;
            }

            if (type === 'se') {
                const source = audioContext.createBufferSource();
                const gain = audioContext.createGain();
                source.buffer = buffer;
                source.connect(gain);
                gain.connect(audioContext.destination);
                
                const vol = globalSettings.sounds?.[sound.id]?.volume || 1;
                gain.gain.value = vol * globalSettings.masterVolume;
                
                source.start(0);
                activeSeSources.push(source);
                source.onended = () => { activeSeSources = activeSeSources.filter(s => s !== source); };
            } else {
                playBgmBuffer(buffer, sound, fadeTime);
            }
        } catch (e) {
            console.error("Play error:", e);
            if(isRemoteOrigin || isObs) showNotification(`再生エラー: ${sound.name}`, 'error');
        }
    }

    function playBgmBuffer(buffer, soundData, fadeTime = 0) {
        const now = audioContext.currentTime;
        if (currentBgmSource && isBgmPlaying) {
            const oldGain = currentBgmGain;
            const oldSource = currentBgmSource;
            oldGain.gain.cancelScheduledValues(now);
            oldGain.gain.setValueAtTime(oldGain.gain.value, now);
            oldGain.gain.linearRampToValueAtTime(0, now + fadeTime);
            oldSource.stop(now + fadeTime);
        }
        const source = audioContext.createBufferSource();
        const gain = audioContext.createGain();
        source.buffer = buffer;
        source.loop = isBgmLoop;
        source.connect(gain);
        gain.connect(audioContext.destination);
        
        const vol = document.getElementById('bgm-volume').value * globalSettings.masterVolume;
        gain.gain.setValueAtTime(vol, now); 
        
        source.start(now);
        currentBgmSource = source;
        currentBgmGain = gain;
        currentBgmId = soundData.id;
        currentBgmBuffer = buffer;
        currentBgmStartTime = now;
        isBgmPlaying = true;
        
        updateBgmStatus(soundData.name, true);
        updatePlayPauseIcon();
        startBgmTimer();
        
        source.onended = () => {
            if (currentBgmSource === source) {
                if (!isBgmLoop) {
                   isBgmPlaying = false;
                   updatePlayPauseIcon();
                   updateBgmStatus("停止中", false);
                   clearInterval(bgmTimer);
                }
            }
        };
    }

    function stopBgm(withFade = false) {
        if (currentBgmSource) {
            const now = audioContext.currentTime;
            const fade = withFade ? globalSettings.fadeTime : 0.1;
            currentBgmGain.gain.cancelScheduledValues(now);
            currentBgmGain.gain.setValueAtTime(currentBgmGain.gain.value, now);
            currentBgmGain.gain.linearRampToValueAtTime(0, now + fade);
            currentBgmSource.stop(now + fade);
            currentBgmSource = null;
            isBgmPlaying = false;
        }
        updatePlayPauseIcon();
        updateBgmStatus("停止中", false);
        const footerTitle = document.querySelector('#bgm-controls .bgm-title');
        const footerArtist = document.querySelector('#bgm-controls .bgm-artist');
        const footerArt = document.querySelector('#bgm-controls .bgm-art');
        if(footerTitle) footerTitle.textContent = "停止中";
        if(footerArtist) footerArtist.textContent = "";
        if(footerArt) { footerArt.style.backgroundImage = 'none'; footerArt.textContent = '🎵'; }
        
        document.getElementById('bgm-time-display').textContent = "0:00 / 0:00";
        const seek = document.getElementById('bgm-seek-bar');
        seek.value = 0;
        updateSliderBackground(seek);
        if (bgmTimer) clearInterval(bgmTimer);
    }

    function stopAllSe() {
        activeSeSources.forEach(s => { try { s.stop(); } catch(e){} });
        activeSeSources = [];
        showNotification('SEを全停止しました');
    }

    function renderTabs() {
        const seBoard = document.getElementById('se-board');
        const bgmBoard = document.getElementById('bgm-board');
        seBoard.innerHTML = '';
        bgmBoard.innerHTML = '';
        if (soundsData.se.length === 0) {
            seBoard.innerHTML = '<div class="empty-message">SEファイルが見つかりません。<br>sounds/SE フォルダにファイルを追加してください。</div>';
        } else {
            renderCategoryGroup(seBoard, soundsData.se, 'se');
        }
        const slotContainer = document.createElement('div');
        slotContainer.className = 'sound-grid';
        slotContainer.style.marginBottom = '10px';
        const addBtn = document.createElement('button');
        addBtn.id = 'add-bgm-slot-btn';
        addBtn.textContent = '＋ 固定項目を追加';
        addBtn.onclick = () => {
            const newId = `slot-${Date.now()}`;
            globalSettings.customBgmSlots.push({ id: newId, name: '新規項目', assignedFileId: null });
            saveSettings();
            renderTabs();
        };
        globalSettings.customBgmSlots.forEach(slot => {
            slotContainer.appendChild(createButton(slot, 'bgm', true));
        });
        bgmBoard.appendChild(addBtn);
        bgmBoard.appendChild(slotContainer);
        if (soundsData.bgm.length > 0) {
            const divider = document.createElement('hr');
            divider.className = 'section-divider';
            bgmBoard.appendChild(divider);
            renderCategoryGroup(bgmBoard, soundsData.bgm, 'bgm');
        } else {
            const msg = document.createElement('div');
            msg.className = 'empty-message';
            msg.innerHTML = 'BGMファイルが見つかりません。<br>sounds/BGM フォルダにファイルを追加してください。';
            bgmBoard.appendChild(msg);
        }
        updateAllSliders();
    }

    function renderCategoryGroup(board, items, type) {
        const groups = {};
        items.forEach(i => { const c = i.category; if (!groups[c]) groups[c] = []; groups[c].push(i); });
        Object.keys(groups).forEach(cat => {
            const group = document.createElement('div'); group.className = 'category-group';
            const title = document.createElement('div'); title.className = 'category-title'; title.textContent = cat; group.appendChild(title);
            const grid = document.createElement('div'); grid.className = 'sound-grid';
            groups[cat].forEach(s => grid.appendChild(createButton(s, type)));
            group.appendChild(grid); board.appendChild(group);
        });
    }

    const createButton = (data, type, isSlot = false) => {
        const button = document.createElement('div');
        button.className = 'sound-btn';
        if (isSlot && !data.assignedFileId) button.classList.add('unassigned');
        if (!isSlot && data.id === currentBgmId) button.classList.add('bgm-playing');
        else if (isSlot && data.assignedFileId === currentBgmId) button.classList.add('bgm-playing');

        if (type === 'bgm') {
            const nameDisplay = isSlot ? data.name : data.name.replace(/\.[^/.]+$/, "");
            const optionBtn = `<button class="options-btn" title="メニュー">︙</button>`;
            let infoHTML = '';
            if (isSlot) {
                infoHTML = `<div class="bgm-info-container"><div class="bgm-text"><div class="bgm-title">${nameDisplay}</div><div class="bgm-artist">固定項目</div></div></div>`;
            } else {
                const elementId = `bgm-item-${data.id.replace(/[^a-zA-Z0-9]/g, '')}`;
                button.id = elementId;
                infoHTML = `<div class="bgm-info-container"><div class="bgm-art">🎵</div><div class="bgm-text"><div class="bgm-title">${nameDisplay}</div><div class="bgm-artist">Unknown Artist</div></div></div>`;
                setTimeout(() => fetchMetadata(data, elementId), 0);
            }
            button.innerHTML = `${infoHTML}${optionBtn}`;
        } else {
            const nameDisplay = data.name.replace(/\.[^/.]+$/, "");
            const savedVol = globalSettings.sounds && globalSettings.sounds[data.id] ? globalSettings.sounds[data.id].volume : 1;
            
            // ★修正: data-se-id を追加して識別可能にする
            const volSlider = `<div class="se-vol-wrapper"><i class="material-icons-round" style="font-size:12px; color:#aaa;">volume_up</i><input type="range" class="volume-slider" min="0" max="1" step="0.01" value="${savedVol}" data-se-id="${data.id}"></div>`;
            
            button.innerHTML = `<div class="btn-name">${nameDisplay}</div>${volSlider}`;
            setTimeout(() => { const slider = button.querySelector('.volume-slider'); if(slider) updateSliderBackground(slider); }, 0);
        }

        button.addEventListener('click', (e) => {
            if (e.target.closest('.volume-slider') || e.target.closest('.se-vol-wrapper')) return;
            if (e.target.closest('.controls-wrapper') || e.target.closest('.options-btn') || e.target.closest('.option-menu') || e.target.closest('input[type=range]')) return;
            if (document.body.classList.contains('volume-adjust-mode')) return;

            if (type === 'se') {
                button.classList.add('playing');
                setTimeout(() => button.classList.remove('playing'), 500);
                playSoundFile(data, 'se');
            } else if (type === 'bgm') {
                let target = data;
                if (isSlot) {
                    if (!data.assignedFileId) { openSlotSettings(data.id); return; }
                    target = soundsData.bgm.find(s => s.id === data.assignedFileId);
                }
                if (target) playSoundFile(target, 'bgm', globalSettings.fadeTime);
            }
        });

        if (type === 'bgm') {
            const optBtn = button.querySelector('.options-btn');
            if(optBtn) {
                optBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const menuItems = isSlot ? 
                        [{ label: '🖊️ 編集', action: () => openSlotSettings(data.id) }, { label: '🕒 予約', action: () => openReservationModal(data.assignedFileId) }, { label: '🗑️ 削除', class: 'delete', action: () => deleteSlot(data.id) }] : 
                        [{ label: '🕒 予約', action: () => openReservationModal(data.id) }];
                    createOptionMenu(e.target, menuItems);
                });
            }
        }
        
        if (type === 'se') {
            const vs = button.querySelector('.volume-slider');
            if(vs) {
                vs.addEventListener('input', (e) => { 
                    e.stopPropagation(); 
                    updateSliderBackground(e.target);
                    
                    if (!globalSettings.sounds) globalSettings.sounds = {};
                    if (!globalSettings.sounds[data.id]) globalSettings.sounds[data.id] = {};
                    globalSettings.sounds[data.id].volume = parseFloat(e.target.value);
                    saveSettings(); 
                    
                    // ★追加: リモコンの場合、SE音量変更を送信
                    if (!isObs && !globalSettings.playOnRemote) {
                        sendCommand({ type: 'volume', target: 'se', id: data.id, value: e.target.value });
                    }
                });
                enableWheelControl(vs);
            }
        }
        return button;
    };

    function loadSettings() {
        const saved = localStorage.getItem('obs_pon_settings');
        if (saved) {
            const parsed = JSON.parse(saved);
            globalSettings = { ...globalSettings, ...parsed };
            applyTheme(globalSettings.themeColor || '#3ea6ff');
            document.documentElement.style.setProperty('--columns', globalSettings.columns);
            document.documentElement.style.setProperty('--bgm-columns', globalSettings.bgmColumns);
            document.getElementById('columns-input').value = globalSettings.columns;
            document.getElementById('bgm-columns-input').value = globalSettings.bgmColumns;
            document.getElementById('fade-time-input').value = globalSettings.fadeTime;
            document.getElementById('master-volume').value = globalSettings.masterVolume;
            document.getElementById('se-folder-input').value = globalSettings.seFolder;
            document.getElementById('bgm-folder-input').value = globalSettings.bgmFolder;
            document.getElementById('play-on-remote-checkbox').checked = globalSettings.playOnRemote;
        }
    }

    function saveSettings() {
        localStorage.setItem('obs_pon_settings', JSON.stringify(globalSettings));
    }

    function startBgmTimer() {
        if (bgmTimer) clearInterval(bgmTimer);
        bgmTimer = setInterval(() => {
            if (currentBgmSource && isBgmPlaying && !isSeeking) {
                const duration = currentBgmBuffer ? currentBgmBuffer.duration : 0;
                let currentTime = audioContext.currentTime - currentBgmStartTime;
                if (duration > 0) {
                    if (currentTime > duration && isBgmLoop) { currentTime = currentTime % duration; }
                    const percent = Math.min((currentTime / duration) * 100, 100);
                    const bar = document.getElementById('bgm-seek-bar');
                    bar.value = percent;
                    updateSliderBackground(bar);
                    const m = Math.floor(currentTime/60);
                    const s = Math.floor(currentTime%60);
                    const dm = Math.floor(duration/60);
                    const ds = Math.floor(duration%60);
                    document.getElementById('bgm-time-display').textContent = `${m}:${String(s).padStart(2,'0')} / ${dm}:${String(ds).padStart(2,'0')}`;
                }
            }
        }, 500);
    }

    function updateBgmStatus(text, isPlaying) {
        document.getElementById('current-bgm-name').textContent = text;
        document.getElementById('bgm-indicator').style.display = isPlaying ? 'inline-block' : 'none';
    }

    function updatePlayPauseIcon() {
        document.getElementById('bgm-play-pause-btn').textContent = isBgmPlaying ? 'pause' : 'play_arrow';
    }

    document.getElementById('bgm-play-pause-btn').addEventListener('click', () => {
        if (currentBgmSource) {
            if (audioContext.state === 'suspended') audioContext.resume();
            if (isBgmPlaying) { audioContext.suspend(); isBgmPlaying = false; }
            else { audioContext.resume(); isBgmPlaying = true; }
            updatePlayPauseIcon();
        }
    });

    document.getElementById('bgm-stop-btn').addEventListener('click', () => {
        if (!isObs && !globalSettings.playOnRemote) { sendCommand({ type: 'stopBgm', fade: false }); } 
        stopBgm(false);
    });
    
    document.getElementById('bgm-fade-stop-btn').addEventListener('click', () => {
        if (!isObs && !globalSettings.playOnRemote) { sendCommand({ type: 'stopBgm', fade: true }); }
        stopBgm(true);
    });

    document.getElementById('bgm-loop-btn').addEventListener('click', (e) => {
        isBgmLoop = !isBgmLoop;
        e.target.classList.toggle('active', isBgmLoop);
        if(currentBgmSource) currentBgmSource.loop = isBgmLoop;
    });

    function updateSliderBackground(slider) {
        const val = (slider.value - slider.min) / (slider.max - slider.min) * 100;
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-color').trim();
        slider.style.backgroundImage = `linear-gradient(to right, ${accent} 0%, ${accent} ${val}%, #4d4d4d ${val}%, #4d4d4d 100%)`;
    }
    
    function updateAllSliders() { document.querySelectorAll('input[type=range]').forEach(updateSliderBackground); }

    function enableWheelControl(element, step = 0.05) {
        element.addEventListener('wheel', (e) => {
            e.preventDefault();
            const direction = e.deltaY < 0 ? 1 : -1;
            const currentVal = parseFloat(element.value);
            const min = parseFloat(element.min);
            const max = parseFloat(element.max);
            let newVal = currentVal + (step * direction);
            newVal = Math.min(Math.max(newVal, min), max);
            element.value = newVal;
            element.dispatchEvent(new Event('input'));
        }, { passive: false });
    }

    ['master-volume', 'bgm-volume'].forEach(id => {
        const el = document.getElementById(id);
        el.addEventListener('input', (e) => {
            updateSliderBackground(e.target);
            if(id==='master-volume') globalSettings.masterVolume = e.target.value;
            if(id==='bgm-volume' && currentBgmGain) {
                 currentBgmGain.gain.setTargetAtTime(e.target.value * globalSettings.masterVolume, audioContext.currentTime, 0.1);
            }
            
            // ★追加: マスター/BGM音量の変更を送信
            if (!isObs && !globalSettings.playOnRemote) {
                sendCommand({ type: 'volume', target: id === 'master-volume' ? 'master' : 'bgm', value: e.target.value });
            }
        });
        el.addEventListener('change', saveSettings);
        enableWheelControl(el, 0.05);
    });

    const seekBar = document.getElementById('bgm-seek-bar');
    seekBar.addEventListener('wheel', (e) => {
        e.preventDefault();
        if(!currentBgmBuffer) return;
        const direction = e.deltaY < 0 ? 1 : -1;
        let newVal = parseFloat(seekBar.value) + (5 * direction); 
        newVal = Math.min(Math.max(newVal, 0), 100);
        seekBar.value = newVal;
        seekBar.dispatchEvent(new Event('input'));
        seekBar.dispatchEvent(new Event('change'));
    }, { passive: false });

    seekBar.addEventListener('input', (e) => { updateSliderBackground(e.target); });
    seekBar.addEventListener('change', (e) => {
        if(currentBgmBuffer && isBgmPlaying) {
            const seekTime = (e.target.value / 100) * currentBgmBuffer.duration;
            playBgmBufferAtOffset(currentBgmBuffer, soundsData.bgm.find(s => s.id === currentBgmId), seekTime);
        }
    });

    function playBgmBufferAtOffset(buffer, soundData, offset) {
        const now = audioContext.currentTime;
        const source = audioContext.createBufferSource();
        const gain = audioContext.createGain();
        source.buffer = buffer;
        source.loop = isBgmLoop;
        source.connect(gain);
        gain.connect(audioContext.destination);
        const vol = document.getElementById('bgm-volume').value * globalSettings.masterVolume;
        gain.gain.value = vol;
        source.start(now, offset);
        if(currentBgmSource) currentBgmSource.stop();
        currentBgmSource = source;
        currentBgmGain = gain;
        currentBgmStartTime = now - offset;
        isBgmPlaying = true;
        source.onended = () => {
            if (currentBgmSource === source && !isBgmLoop) {
                   isBgmPlaying = false; updatePlayPauseIcon(); updateBgmStatus("停止中", false); clearInterval(bgmTimer);
            }
        };
    }

    document.getElementById('settings-btn').addEventListener('click', () => document.getElementById('settings-modal').style.display = 'block');
    document.querySelectorAll('.close-btn').forEach(b => b.addEventListener('click', (e) => e.target.closest('.modal').style.display = 'none'));
    document.getElementById('columns-input').addEventListener('input', (e) => { globalSettings.columns = e.target.value; document.documentElement.style.setProperty('--columns', e.target.value); saveSettings(); });
    document.getElementById('bgm-columns-input').addEventListener('input', (e) => { globalSettings.bgmColumns = e.target.value; document.documentElement.style.setProperty('--bgm-columns', e.target.value); saveSettings(); });
    document.getElementById('fade-time-input').addEventListener('input', (e) => { globalSettings.fadeTime = parseFloat(e.target.value); saveSettings(); });
    document.getElementById('se-folder-input').addEventListener('change', (e) => { globalSettings.seFolder = e.target.value; saveSettings(); loadSounds(); });
    document.getElementById('bgm-folder-input').addEventListener('change', (e) => { globalSettings.bgmFolder = e.target.value; saveSettings(); loadSounds(); });
    document.getElementById('play-on-remote-checkbox').addEventListener('change', (e) => { globalSettings.playOnRemote = e.target.checked; saveSettings(); });

    document.querySelectorAll('.theme-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
            const c = e.target.dataset.color;
            const h = e.target.dataset.hover;
            globalSettings.themeColor = c;
            applyTheme(c, h);
            saveSettings();
        });
    });

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            document.querySelectorAll('.sound-board').forEach(b => b.classList.remove('active'));
            document.getElementById(`${e.target.dataset.target}-board`).classList.add('active');
        });
    });
    
    document.getElementById('reservation-btn').addEventListener('click', () => document.getElementById('reservation-queue-floating').classList.toggle('visible'));
    document.getElementById('close-queue-btn').addEventListener('click', () => document.getElementById('reservation-queue-floating').classList.remove('visible'));

    const slotSettingsModal = document.getElementById('slot-settings-modal');
    let editingSlotId = null;
    window.openSlotSettings = (slotId) => {
        editingSlotId = slotId;
        const slot = globalSettings.customBgmSlots.find(s => s.id === slotId);
        if(!slot) return;
        document.getElementById('slot-name-input').value = slot.name;
        const sel = document.getElementById('slot-file-select');
        sel.innerHTML = '<option value="">(未設定)</option>';
        soundsData.bgm.forEach(s => {
             const opt = document.createElement('option'); opt.value = s.id; opt.textContent = s.name; sel.appendChild(opt);
        });
        sel.value = slot.assignedFileId || "";
        slotSettingsModal.style.display = 'block';
    };
    document.getElementById('save-slot-btn').addEventListener('click', () => {
        const slot = globalSettings.customBgmSlots.find(s => s.id === editingSlotId);
        if(slot) {
            slot.name = document.getElementById('slot-name-input').value;
            slot.assignedFileId = document.getElementById('slot-file-select').value;
            saveSettings();
            renderTabs();
        }
        slotSettingsModal.style.display = 'none';
    });
    window.deleteSlot = (id) => {
        if(confirm('削除しますか？')) {
            globalSettings.customBgmSlots = globalSettings.customBgmSlots.filter(s => s.id !== id);
            saveSettings();
            renderTabs();
        }
    };

    window.addEventListener('click', (e) => { if (!e.target.closest('.options-btn')) document.querySelectorAll('.option-menu').forEach(m => m.remove()); });
    window.createOptionMenu = (btn, items) => {
        document.querySelectorAll('.option-menu').forEach(m => m.remove());
        const menu = document.createElement('div'); menu.className = 'option-menu visible';
        items.forEach(i => {
            const el = document.createElement('div'); el.className = `menu-item ${i.class||''}`; el.textContent = i.label;
            el.addEventListener('click', (e) => { e.stopPropagation(); i.action(); menu.remove(); });
            menu.appendChild(el);
        });
        btn.parentElement.appendChild(menu);
    };

    const reservationModal = document.getElementById('reservation-modal');
    window.openReservationModal = (fileId) => {
        const sel = document.getElementById('reservation-bgm-select');
        sel.innerHTML = '<option value="">(選択)</option>';
        soundsData.bgm.forEach(b => {
            const opt = document.createElement('option'); opt.value = b.id; opt.textContent = b.name; sel.appendChild(opt);
        });
        if(fileId) sel.value = fileId;
        const now = new Date(); now.setMinutes(now.getMinutes()+1);
        document.getElementById('reservation-time').value = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
        reservationModal.style.display = 'block';
    };
    document.querySelector('.reservation-close').addEventListener('click', () => reservationModal.style.display = 'none');
    
    document.getElementById('add-reservation-btn').addEventListener('click', () => {
        const t=document.getElementById('reservation-time').value, f=document.getElementById('reservation-bgm-select').value;
        if(!t||!f)return alert('必須入力');
        reservationQueue.push({id:Date.now(), timeStr:t, bgmId:f, mode:'crossfade'});
        reservationQueue.sort((a,b)=>a.timeStr.localeCompare(b.timeStr));
        renderQueue();
        reservationModal.style.display='none';
        document.getElementById('reservation-queue-floating').classList.add('visible');
        showNotification('予約しました', 'success');
    });

    function renderQueue() {
        const l=document.getElementById('floating-queue-list');
        l.innerHTML=reservationQueue.length?reservationQueue.map(q=>`<div class="queue-item"><span class="queue-time">${q.timeStr}</span><span class="queue-name">${soundsData.bgm.find(x=>x.id===q.bgmId)?.name||'?'}</span><span class="queue-delete" data-id="${q.id}">🗑</span></div>`).join(''):'<div style="padding:20px;text-align:center;color:#666;font-size:0.9rem;">予約はありません</div>';
        l.querySelectorAll('.queue-delete').forEach(b=>b.addEventListener('click',e=>{reservationQueue=reservationQueue.filter(x=>x.id!==Number(e.target.dataset.id));renderQueue();}));
    }

    function applyTheme(color, hover) {
        document.documentElement.style.setProperty('--accent-color', color);
        if(hover) document.documentElement.style.setProperty('--accent-hover', hover);
        document.documentElement.style.setProperty('--accent-light', color + '33');
        updateAllSliders();
    }

    setInterval(() => {
        const now = new Date();
        document.getElementById('clock-display').textContent = now.toLocaleTimeString('ja-JP', {hour12:false});
        const shortTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
        if(now.getSeconds()===0) {
            const taskIndex = reservationQueue.findIndex(t => t.timeStr === shortTime);
            if(taskIndex !== -1) {
                const task = reservationQueue[taskIndex];
                const sound = soundsData.bgm.find(s => s.id === task.bgmId);
                if(sound) {
                    playSoundFile(sound, 'bgm', globalSettings.fadeTime);
                    showNotification(`予約実行: ${sound.name}`, 'success');
                }
                reservationQueue.splice(taskIndex, 1);
                renderQueue();
            }
        }
        if(reservationQueue.length > 0) {
             document.getElementById('reservation-status-bar').classList.add('active');
             const next = reservationQueue[0];
             const [h,m] = next.timeStr.split(':');
             const target = new Date(now); target.setHours(h,m,0,0); if(target<now)target.setDate(target.getDate()+1);
             const diff = target-now;
             const hrs=Math.floor(diff/3600000), mins=Math.floor((diff%3600000)/60000), secs=Math.floor((diff%60000)/1000);
             document.getElementById('bar-countdown').textContent = `${String(hrs).padStart(2,'0')}:${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
             document.getElementById('bar-next-song').textContent = soundsData.bgm.find(s=>s.id===next.bgmId)?.name || '?';
        } else {
             document.getElementById('reservation-status-bar').classList.remove('active');
        }
    }, 1000);

    async function loadExternalFolders() {
        try {
            const res = await fetch('/api/folders');
            const folders = await res.json();
            renderFolderList(folders);
        } catch(e) { console.error(e); }
    }

    function renderFolderList(folders) {
        const list = document.getElementById('ext-folder-list');
        list.innerHTML = '';
        if (folders.length === 0) {
            list.innerHTML = '<div style="color:#666; font-size:0.8rem; text-align:center;">設定されたフォルダはありません</div>';
            return;
        }
        folders.forEach((f, index) => {
            const row = document.createElement('div');
            row.style.display = 'flex'; row.style.justifyContent = 'space-between'; row.style.alignItems = 'center';
            row.style.marginBottom = '5px'; row.style.fontSize = '0.9rem'; row.style.borderBottom = '1px solid #333'; row.style.paddingBottom = '5px';
            
            const info = document.createElement('div');
            info.innerHTML = `<span style="color:var(--accent-color); font-weight:bold;">[${f.type}]</span> ${f.path}`;
            info.style.overflow = 'hidden'; info.style.textOverflow = 'ellipsis'; info.style.whiteSpace = 'nowrap'; info.style.marginRight = '10px';
            
            const delBtn = document.createElement('button');
            delBtn.textContent = '×';
            delBtn.style.background = '#ff4e45'; delBtn.style.padding = '2px 8px'; delBtn.style.fontSize = '0.8rem';
            delBtn.onclick = () => removeExternalFolder(index);
            
            row.appendChild(info);
            row.appendChild(delBtn);
            list.appendChild(row);
        });
    }

    async function addExternalFolder() {
        const pathInput = document.getElementById('ext-folder-path');
        const typeInput = document.getElementById('ext-folder-type');
        const pathStr = pathInput.value.trim().replace(/"/g, ''); 
        
        if (!pathStr) return alert('パスを入力してください');
        
        try {
            const res = await fetch('/api/folders');
            const folders = await res.json();
            if(folders.some(f => f.path === pathStr)) return alert('このフォルダは既に登録されています');
            folders.push({ path: pathStr, type: typeInput.value, alias: pathStr.split(/[\\/]/).pop() });
            
            await fetch('/api/folders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(folders)
            });
            
            pathInput.value = '';
            loadExternalFolders();
            loadSounds(); 
            showNotification('フォルダを追加しました', 'success');
        } catch(e) {
            alert('保存に失敗しました');
        }
    }

    async function removeExternalFolder(index) {
        if(!confirm('このフォルダの監視を解除しますか？')) return;
        try {
            const res = await fetch('/api/folders');
            const folders = await res.json();
            folders.splice(index, 1);
            await fetch('/api/folders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(folders)
            });
            loadExternalFolders();
            loadSounds();
        } catch(e) { console.error(e); }
    }

    document.getElementById('add-ext-folder-btn').addEventListener('click', addExternalFolder);
    document.getElementById('settings-btn').addEventListener('click', () => { loadExternalFolders(); });

    const seStopBtn = document.getElementById('se-stop-btn');
    if(seStopBtn) {
        seStopBtn.addEventListener('click', () => {
            if (!isObs && !globalSettings.playOnRemote) { sendCommand({ type: 'stopSe' }); }
            stopAllSe();
        });
    }

    loadSettings();
    loadSounds();
    updateAllSliders();
    if (isBgmLoop) {
        document.getElementById('bgm-loop-btn').classList.add('active');
    }
    
    connectWebSocket();
});