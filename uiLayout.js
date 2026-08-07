(function (global) {
    /**
     * Initialize UI layout: query DOM elements and wire UI event handlers.
     * Mutates the provided app instance to set element references.
     */
    function initLayout(app) {
        if (!app) return;

        // --- Element queries ---
        // Hidden/Functional elements
        app.apiKeyInput = document.getElementById('apiKeyInput'); // Hidden
        app.connectButton = document.getElementById('connectButton'); // Hidden
        app.voiceList = document.getElementById('voiceList'); // Hidden

        // Main UI Elements
        app.chatMessages = document.getElementById('chatMessages');
        app.chatLoader = document.getElementById('chatLoader');

        // Call mode panel (appears when recording/call is active)
        app.callModePanel = document.getElementById('callModePanel');
        app.callModeAvatarImg = document.getElementById('callModeAvatarImg');
        app.callModeAvatarVideo = document.getElementById('callModeAvatarVideo');
        app.callModeSpeakingVideo = document.getElementById('callModeSpeakingVideo');
        app.callModeWaveVideo = document.getElementById('callModeWaveVideo');
        app.callSpeakerBtn = document.getElementById('callSpeakerBtn');
        app.centerCoachAvatar = document.getElementById('centerCoachAvatar');
        app.voiceBars = document.getElementById('voiceBars');
        app.callSpeakerOnIcon = document.getElementById('callSpeakerOnIcon');
        app.callSpeakerOffIcon = document.getElementById('callSpeakerOffIcon');
        app.callMicMuteBtn = document.getElementById('callMicMuteBtn');
        app.callMicOnIcon = document.getElementById('callMicOnIcon');
        app.callMicOffIcon = document.getElementById('callMicOffIcon');
        app.callEndBtn = document.getElementById('callEndBtn');

        // Header actions
        app.backToCoachListBtn = document.getElementById('backToCoachListBtn');
        app.moreMenuBtn = document.getElementById('moreMenuBtn');
        app.moreMenu = document.getElementById('moreMenu');
        app.menuChangeCoachName = document.getElementById('menuChangeCoachName');
        app.menuSwitchCoachingStyle = document.getElementById('menuSwitchCoachingStyle');
        app.menuClearConversation = document.getElementById('menuClearConversation');
        app.menuSpeedItems = Array.from(document.querySelectorAll('.menuSpeedItem'));
        app.voiceSpeedSection = document.getElementById('voiceSpeedSection');

        // Status Indicators
        app.connectionStatusDot = document.getElementById('connectionStatusDot');
        app.connectionStatusText = document.getElementById('connectionStatusText');
        app.agentNameDisplay = document.getElementById('agentNameDisplay');
        app.coachTypeText = document.getElementById('coachTypeText');
        app.headerAvatar = document.getElementById('headerAvatar');

        // Backward-compatible aliases used throughout `app.js`
        // - `statusText` is used to display the current coach/voice label in legacy UI
        // - `currentVoiceThumb` is used as the active coach avatar/thumb (and for message avatars)
        app.statusText = app.agentNameDisplay || app.statusText || null;
        try {
            const headerImg = app.headerAvatar ? app.headerAvatar.querySelector('img') : null;
            const headerVideo = app.headerAvatar ? app.headerAvatar.querySelector('video') : null;
            app.currentVoiceThumb = headerImg || app.currentVoiceThumb || null;
            app.currentVoiceVideo = headerVideo || app.currentVoiceVideo || null;
        } catch (_) {
            app.currentVoiceThumb = app.currentVoiceThumb || null;
            app.currentVoiceVideo = app.currentVoiceVideo || null;
        }

        // Input & Controls
        app.textInput = document.getElementById('userTextInput'); // New ID
        app.sendTextButton = document.getElementById('sendMessageBtn'); // New ID
        app.inputWrapper = document.getElementById('inputWrapper');

        // Mic Controls
        app.micToggleButton = document.getElementById('micToggleBtn'); // New ID
        app.callButton = app.micToggleButton; // Legacy alias for app.js compatibility
        app.micIcon = document.getElementById('micIcon');
        app.micStopIcon = document.getElementById('micStopIcon');
        app.micRipple = document.getElementById('micRipple');

        // Sound Controls (legacy support, though not in new UI explicitly yet)
        app.soundButton = document.getElementById('soundButton');
        app.isSoundEnabled = true;

        // Coach name modal
        app.coachNameModal = document.getElementById('coachNameModal');
        app.coachNameBackdrop = document.getElementById('coachNameBackdrop');
        app.coachNameInput = document.getElementById('coachNameInput');
        app.coachNameCount = document.getElementById('coachNameCount');
        app.coachNameCloseBtn = document.getElementById('coachNameCloseBtn');
        app.coachNameCancelBtn = document.getElementById('coachNameCancelBtn');
        app.coachNameSaveBtn = document.getElementById('coachNameSaveBtn');

        // Legacy/Compat elements (keep null checks safe)
        app.voiceMenu = document.getElementById('voiceMenu');
        app.voiceMenuOverlay = document.getElementById('voiceMenuOverlay');

        // Scroll-to-bottom floating button — appears when the user has
        // scrolled up from the latest message. Small helper wired directly
        // here since the behavior is purely UI, no app-state dependency.
        (function setupScrollToBottom() {
            const btn = document.getElementById('scrollToBottomBtn');
            const scrollContainer = document.getElementById('chatContainer');
            if (!btn || !scrollContainer) return;

            const NEAR_BOTTOM_THRESHOLD_PX = 80;

            // Expose a shared "is user near the bottom?" test on the app so
            // scroll-follow decisions (e.g. auto-scroll on assistant final)
            // can respect the user's intent — if they scrolled up to read
            // history, don't yank them back down. Matches ChatGPT / Claude
            // scroll behaviour.
            app.isChatNearBottom = function () {
                const distance = scrollContainer.scrollHeight
                    - scrollContainer.scrollTop
                    - scrollContainer.clientHeight;
                return distance <= NEAR_BOTTOM_THRESHOLD_PX;
            };

            // Scroll so a specific message element's TOP sits at the top of
            // the visible viewport (with a small offset). Used on assistant
            // final so the user starts reading from the beginning of the
            // response without having to scroll up manually.
            app.scrollMessageTopIntoView = function (el) {
                if (!el || !scrollContainer) return;
                const offset = 8; // tiny headroom
                const elTop = el.offsetTop - scrollContainer.offsetTop;
                scrollContainer.scrollTo({ top: Math.max(0, elTop - offset), behavior: 'smooth' });
            };

            function updateVisibility() {
                if (app.isChatNearBottom()) {
                    btn.classList.add('hidden');
                } else {
                    btn.classList.remove('hidden');
                }
            }

            scrollContainer.addEventListener('scroll', updateVisibility, { passive: true });
            btn.addEventListener('click', () => {
                scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'smooth' });
            });

            // Recheck when content grows (new messages/pills appended). Node
            // additions inside chatMessages are the main trigger — a small
            // MutationObserver is cheaper than polling.
            const chatMsgs = document.getElementById('chatMessages');
            if (chatMsgs && typeof MutationObserver !== 'undefined') {
                const mo = new MutationObserver(() => updateVisibility());
                mo.observe(chatMsgs, { childList: true, subtree: false });
            }

            // Initial state
            updateVisibility();
        })();

        // State
        app.isBotSpeaking = false;
        app.currentVideoState = 'idle';

        // --- Check for saved state and determine initial UI ---
        // If we have a valid saved session, hide the coach selection and auto-resume
        if (typeof app.shouldShowCoachSelection === 'function') {
            const showSelection = app.shouldShowCoachSelection();

            if (!showSelection) {
                // Hide coach selection modal
                setVoiceMenuOpen(app, false);
                // console.log('[Erica] Auto-resuming from saved state');
            } else {
                // Show coach selection modal (default behavior)
                setVoiceMenuOpen(app, true);
                // console.log('[Erica] No saved state, showing coach selection');
            }
        }

        // --- Event listeners ---

        // Coach/Voice Selection Logic
        app.voiceMenuItems = Array.from(document.querySelectorAll('.voice-menu-item'));
        if (app.voiceMenuItems && app.voiceMenuItems.length > 0) {
            app.voiceMenuItems.forEach((item) => {
                item.addEventListener('click', () => {
                    // Only allow voice change when connected but not recording
                    if (!app.isConnected || app.isRecording) {
                        // Optional: Add visual feedback if locked?
                        return;
                    }

                    const voice = item.getAttribute('data-voice');
                    const thumb = item.getAttribute('data-thumb');
                    const character = item.getAttribute('data-character');

                    if (voice && voice !== app.selectedVoice) {
                        console.log('[Erica] Changing voice to', voice, '(' + character + ')');

                        // Update app state (methods usually on app instance)
                        if (typeof app.setSelectedVoice === 'function') {
                            app.setSelectedVoice(voice, thumb, character);
                        }

                        // Close menu
                        const overlay = document.getElementById('voiceMenuOverlay');
                        if (overlay) overlay.style.display = 'none';

                        // Update Active State in UI
                        // Remove active from all
                        app.voiceMenuItems.forEach(mi => {
                            mi.classList.remove('active');
                            mi.querySelector('.group-\\[\\.active\\]\\:opacity-100')?.classList.remove('opacity-100');
                            mi.querySelector('.group-\\[\\.active\\]\\:opacity-100')?.classList.add('opacity-0');
                        });
                        // Add to current
                        item.classList.add('active');
                        item.querySelector('.group-\\[\\.active\\]\\:opacity-100')?.classList.remove('opacity-0');
                        item.querySelector('.group-\\[\\.active\\]\\:opacity-100')?.classList.add('opacity-100');

                        // Trigger reconnect if needed
                        if (app.isConnected && typeof app.reconnectWithNewVoice === 'function') {
                            app.reconnectWithNewVoice();
                        }
                    } else if (voice === app.selectedVoice) {
                        // Just close if same
                        const overlay = document.getElementById('voiceMenuOverlay');
                        if (overlay) overlay.style.display = 'none';
                    }
                });
            });
        }

        // --- Input Handlers ---
        if (app.textInput) {
            app.textInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    app.sendTextMessage();
                }
            });
            app.textInput.addEventListener('input', () => {
                updateTextButtonVisibility(app);
                // Restore from on hold as soon as user starts typing
                if (app.isOnHold && app.isConnected) {
                    app.isOnHold = false;
                    updateStatusDot(app, 'connected');
                    if (typeof app.startSessionInactivityTimer === 'function') {
                        app.startSessionInactivityTimer();
                    }
                }
            });
        }

        if (app.sendTextButton) {
            app.sendTextButton.addEventListener('click', () => app.sendTextMessage());
        }

        if (app.micToggleButton) {
            app.micToggleButton.addEventListener('click', () => {
                app.toggleMicTrack();
            });
        }

        // More menu (3-dot dropdown)
        if (app.moreMenuBtn && app.moreMenu) {
            app.moreMenuBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const next = !isMoreMenuOpen(app);
                setMoreMenuOpen(app, next);
            });
        }
        if (app.menuChangeCoachName) {
            app.menuChangeCoachName.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                setMoreMenuOpen(app, false);

                // Analytics: Clicked Change Persona Name
                if (typeof app.trackCoachEvent === 'function') {
                    app.trackCoachEvent('Clicked Change Persona Name', {});
                }

                if (typeof app.promptCoachNameChange === 'function') {
                    app.promptCoachNameChange();
                }
            });
        }

        // Coach name modal handlers
        const updateCoachNameCount = () => {
            if (!app.coachNameInput || !app.coachNameCount || !app.coachNameSaveBtn) return;
            const raw = app.coachNameInput.value || '';
            const trimmed = raw.trim();
            app.coachNameCount.textContent = `${trimmed.length}/9`;
            app.coachNameSaveBtn.disabled = trimmed.length === 0 || trimmed.length > 9;
        };

        if (app.coachNameInput) {
            app.coachNameInput.addEventListener('input', updateCoachNameCount);
            app.coachNameInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (!app.coachNameSaveBtn?.disabled) {
                        app.coachNameSaveBtn?.click();
                    }
                }
            });
        }
        if (app.coachNameCloseBtn) {
            app.coachNameCloseBtn.addEventListener('click', () => {
                if (typeof app.closeCoachNameModal === 'function') app.closeCoachNameModal();
            });
        }
        if (app.coachNameCancelBtn) {
            app.coachNameCancelBtn.addEventListener('click', () => {
                if (typeof app.closeCoachNameModal === 'function') app.closeCoachNameModal();
            });
        }
        if (app.coachNameBackdrop) {
            app.coachNameBackdrop.addEventListener('click', () => {
                if (typeof app.closeCoachNameModal === 'function') app.closeCoachNameModal();
            });
        }
        if (app.coachNameSaveBtn) {
            app.coachNameSaveBtn.addEventListener('click', () => {
                const trimmed = (app.coachNameInput?.value || '').trim();
                if (!trimmed || trimmed.length > 9) return;
                if (typeof app.setCoachDisplayName === 'function') {
                    app.setCoachDisplayName(trimmed);
                }
                if (typeof app.closeCoachNameModal === 'function') app.closeCoachNameModal();
            });
        }

        app.openCoachNameModal = function (name) {
            if (!app.coachNameModal || !app.coachNameInput) return;
            app.coachNameInput.value = String(name || '').trim();
            if (app.coachNameCount) {
                const len = app.coachNameInput.value.trim().length;
                app.coachNameCount.textContent = `${len}/9`;
            }
            if (app.coachNameSaveBtn) {
                const len = app.coachNameInput.value.trim().length;
                app.coachNameSaveBtn.disabled = len === 0 || len > 9;
            }
            app.coachNameModal.classList.remove('hidden');
            app.coachNameModal.classList.add('flex');
            setTimeout(() => {
                try { app.coachNameInput.focus(); } catch (_) { }
            }, 0);
        };
        app.closeCoachNameModal = function () {
            if (!app.coachNameModal) return;
            app.coachNameModal.classList.add('hidden');
            app.coachNameModal.classList.remove('flex');
        };
        if (app.menuSwitchCoachingStyle) {
            app.menuSwitchCoachingStyle.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                // Prevent switching coaches during voice mode
                if (app.isRecording) return;
                setMoreMenuOpen(app, false);
                // Re-open coach picker
                setVoiceMenuOpen(app, true);
            });
        }
        if (app.menuClearConversation) {
            app.menuClearConversation.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                setMoreMenuOpen(app, false);

                // Show custom confirmation modal (window.confirm is blocked in WebViews)
                const modal = document.getElementById('clearConversationModal');
                if (modal) {
                    modal.classList.remove('hidden');
                    modal.classList.add('flex');
                } else {
                    // Fallback if modal HTML is missing
                    if (typeof app.clearConversation === 'function') app.clearConversation();
                }
            });
        }

        // Clear conversation modal button handlers
        const clearModal = document.getElementById('clearConversationModal');
        const clearConfirmBtn = document.getElementById('clearConversationConfirm');
        const clearCancelBtn = document.getElementById('clearConversationCancel');
        const clearBackdrop = document.getElementById('clearConversationBackdrop');

        const closeClearModal = () => {
            if (clearModal) {
                clearModal.classList.add('hidden');
                clearModal.classList.remove('flex');
            }
        };

        if (clearConfirmBtn) {
            clearConfirmBtn.addEventListener('click', () => {
                closeClearModal();
                if (typeof app.clearConversation === 'function') {
                    app.clearConversation();
                }
            });
        }
        if (clearCancelBtn) {
            clearCancelBtn.addEventListener('click', closeClearModal);
        }
        if (clearBackdrop) {
            clearBackdrop.addEventListener('click', closeClearModal);
        }
        if (app.menuSpeedItems && app.menuSpeedItems.length > 0) {
            app.menuSpeedItems.forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const speed = btn.getAttribute('data-speed');
                    if (speed && typeof app.setVoiceSpeed === 'function') {
                        app.setVoiceSpeed(speed);
                    }
                    updateMoreMenuSpeedChecks(app);
                    setMoreMenuOpen(app, false);
                });
            });
        }

        // Close menu on outside click / Escape
        document.addEventListener('click', (e) => {
            if (!isMoreMenuOpen(app)) return;
            if (app.moreMenu && app.moreMenu.contains(e.target)) return;
            if (app.moreMenuBtn && app.moreMenuBtn.contains(e.target)) return;
            setMoreMenuOpen(app, false);
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && isMoreMenuOpen(app)) {
                setMoreMenuOpen(app, false);
            }
        });

        // Call panel buttons
        if (app.callSpeakerBtn) {
            app.callSpeakerBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (typeof app.toggleSound === 'function') app.toggleSound();
                updateCallPanelSpeakerUI(app);
            });
        }
        if (app.callMicMuteBtn) {
            app.callMicMuteBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (typeof app.toggleSelfMute === 'function') {
                    app.toggleSelfMute();
                }
                updateCallPanelMicUI(app);
            });
        }
        // Delegated listener for Stop button to handle replacement/z-index issues
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('#callEndBtn');
            if (btn) {
                console.log('[Erica Debug] Delegated click on callEndBtn');
                e.preventDefault();
                e.stopPropagation();
                if (typeof app.stopRecording === 'function') {
                    app.stopRecording();
                }
            }
        });

        // Back arrow should re-open the coach picker
        if (app.backToCoachListBtn) {
            app.backToCoachListBtn.addEventListener('click', (e) => {
                e.preventDefault();
                // Avoid switching coaches mid-call; user can stop recording first.
                if (app.isRecording) return;
                if (typeof messageToApp === 'function') {
                    messageToApp({ action: 'ericaOnBackClick' });
                }
                setVoiceMenuOpen(app, true);
            });
        }

        // Expose global method for Android system back button — calls same logic as back arrow
        window.ericaGoBack = function () {
            if (app.isRecording) return;
            if (typeof messageToApp === 'function') {
                messageToApp({ action: 'ericaOnBackClick' });
            }
            setVoiceMenuOpen(app, true);
        };

        // Initialize state
        updateTextButtonVisibility(app);
        setCallModePanelOpen(app, false);
        updateMoreMenuSpeedChecks(app);

        // Hide voice speed controls for guest users
        hideSpeedControlsForGuests(app);

        // Coach list renderer (used by app.js after /api/erica-preparation returns companions)
        // IMPORTANT: bind to this specific app instance (avoid referencing an undefined global "app").
        app.renderCoachList = function (companions, navigatorResult) {
            return renderCoachList(app, companions, navigatorResult);
        };

        // Login prompt modal (shown when unauthenticated users try to use voice mode)
        app.loginPromptModal = document.getElementById('loginPromptModal');
        app.loginPromptBackdrop = document.getElementById('loginPromptBackdrop');
        app.loginPromptCloseBtn = document.getElementById('loginPromptCloseBtn');
        app.loginPromptYesBtn = document.getElementById('loginPromptYesBtn');
        app.loginPromptNoBtn = document.getElementById('loginPromptNoBtn');

        if (app.loginPromptCloseBtn) {
            app.loginPromptCloseBtn.addEventListener('click', () => {
                if (typeof app.hideLoginPrompt === 'function') app.hideLoginPrompt();
            });
        }
        /*if (app.loginPromptBackdrop) {
            app.loginPromptBackdrop.addEventListener('click', () => {
                if (typeof app.hideLoginPrompt === 'function') app.hideLoginPrompt();
            });
        }*/
        if (app.loginPromptNoBtn) {
            app.loginPromptNoBtn.addEventListener('click', () => {
                if (typeof app.hideLoginPrompt === 'function') app.hideLoginPrompt();
            });
        }
        if (app.loginPromptYesBtn) {
            app.loginPromptYesBtn.addEventListener('click', () => {
                // Analytics: user tapped "Yes, I Want Personalized Guidance"
                if (typeof app.trackCoachEvent === 'function') {
                    app.trackCoachEvent('Requested Sign Up', { Intent: 'voice' });
                }

                // Save intention to call so next load (with userId) auto-restores call mode
                if (typeof app.saveCurrentState === 'function') {
                    app.saveCurrentState('call');
                }

                // Redirect to signup/login page
                if (typeof app.handleLoginPromptAccept === 'function') {
                    app.handleLoginPromptAccept();
                } else {
                    // Send to parent iframe (Wix)
                    if (app.iframeMessaging && typeof app.iframeMessaging.sendToHost === 'function') {
                        console.log('[Erica] Sending login request via sendToHost...');
                        app.iframeMessaging.sendToHost({ action: "ericaRequestLogin" });
                    }
                    // Send to native app (iOS / Android)
                    if (typeof messageToApp === 'function') {
                        messageToApp({ action: "ericaRequestLogin" });
                    }
                }
                if (typeof app.hideLoginPrompt === 'function') app.hideLoginPrompt();
            });
        }

        app.showLoginPrompt = function () {
            if (!app.loginPromptModal) return;
            app.loginPromptModal.classList.remove('hidden');
            app.loginPromptModal.classList.add('flex');
            // Analytics: modal appeared
            if (typeof app.trackCoachEvent === 'function') {
                app.trackCoachEvent('Shown Sign Up Prompt', {});
            }
            // Send action to native app (iOS/Android) - like login button
            if (typeof messageToApp === 'function') {
                messageToApp({ action: "ericaShowSignUpPrompt" });
            }
        };
        app.hideLoginPrompt = function () {
            if (!app.loginPromptModal) return;
            app.loginPromptModal.classList.add('hidden');
            app.loginPromptModal.classList.remove('flex');
        };

        // Limit Reached Prompt (shown when questionsLimit is exceeded)
        app.limitReachedModal = document.getElementById('limitReachedModal');
        app.limitReachedBackdrop = document.getElementById('limitReachedBackdrop');
        app.limitReachedCloseBtn = document.getElementById('limitReachedCloseBtn');
        app.limitReachedOkBtn = document.getElementById('limitReachedOkBtn');

        app.hideLimitReachedPrompt = function () {
            if (!app.limitReachedModal) return;
            app.limitReachedModal.classList.add('hidden');
            app.limitReachedModal.classList.remove('flex');

            // Safeguard: Ensure recording is stopped when user acknowledges the limit
            if (typeof app.stopRecording === 'function') {
                console.log('[Erica] Limit modal closed - enforcing stopRecording (Force)');
                app.stopRecording(true);
            }
        };

        app.showLimitReachedPrompt = function () {
            if (!app.limitReachedModal) return;
            app.limitReachedModal.classList.remove('hidden');
            app.limitReachedModal.classList.add('flex');
            // Analytics: voice limit reached
            if (typeof app.trackCoachEvent === 'function') {
                app.trackCoachEvent('Voice Limit Reached', {});
            }
        };

        if (app.limitReachedCloseBtn) {
            app.limitReachedCloseBtn.addEventListener('click', app.hideLimitReachedPrompt);
        }
        if (app.limitReachedBackdrop) {
            app.limitReachedBackdrop.addEventListener('click', app.hideLimitReachedPrompt);
        }
        if (app.limitReachedOkBtn) {
            app.limitReachedOkBtn.addEventListener('click', app.hideLimitReachedPrompt);
        }

        // Voice Limit Upgrade Modal (shown when user clicks mic after limit reached)
        app.voiceUpgradeModal = document.getElementById('voiceUpgradeModal');
        app.voiceUpgradeBackdrop = document.getElementById('voiceUpgradeBackdrop');
        app.upgradeCloseBtn = document.getElementById('upgradeCloseBtn');
        app.upgradeYesBtn = document.getElementById('upgradeYesBtn');
        app.upgradeNoBtn = document.getElementById('upgradeNoBtn');

        app.hideVoiceLimitUpgradeModal = function () {
            if (!app.voiceUpgradeModal) return;
            app.voiceUpgradeModal.classList.add('hidden');
            app.voiceUpgradeModal.classList.remove('flex');
        };

        app.showVoiceLimitUpgradeModal = function () {
            if (!app.voiceUpgradeModal) return;
            app.voiceUpgradeModal.classList.remove('hidden');
            app.voiceUpgradeModal.classList.add('flex');
            // Analytics: upgrade prompt shown
            if (typeof app.trackCoachEvent === 'function') {
                app.trackCoachEvent('Shown Upgrade Prompt', {});
            }
        };

        if (app.upgradeCloseBtn) {
            app.upgradeCloseBtn.addEventListener('click', app.hideVoiceLimitUpgradeModal);
        }
        if (app.voiceUpgradeBackdrop) {
            app.voiceUpgradeBackdrop.addEventListener('click', app.hideVoiceLimitUpgradeModal);
        }
        if (app.upgradeNoBtn) {
            app.upgradeNoBtn.addEventListener('click', app.hideVoiceLimitUpgradeModal);
        }
        if (app.upgradeYesBtn) {
            app.upgradeYesBtn.addEventListener('click', () => {
                console.log('[Erica] User clicked "Yep, upgrade me"');

                // Analytics: upgrade requested
                if (typeof app.trackCoachEvent === 'function') {
                    app.trackCoachEvent('Requested Upgrade', {});
                }

                // Save intention to call so next load (after upgrade) auto-restores call mode
                if (typeof app.saveCurrentState === 'function') {
                    app.saveCurrentState('call');
                }

                // Send upgrade request to parent frame
                if (app.iframeMessaging && typeof app.iframeMessaging.sendToHost === 'function') {
                    console.log('[Erica] Sending upgrade request via sendToHost...');
                    app.iframeMessaging.sendToHost({ action: "ericaRequestUpgrade" });
                }

                // Send upgrade request to native app (iOS / Android)
                if (typeof messageToApp === 'function') {
                    messageToApp({ action: "ericaRequestUpgrade" });
                }

                app.hideVoiceLimitUpgradeModal();
            });
        }

        // Voice Inactivity Modal (shown when no audio detected for 30 seconds)
        app.voiceInactivityModal = document.getElementById('voiceInactivityModal');
        app.voiceInactivityBackdrop = document.getElementById('voiceInactivityBackdrop');
        app.voiceInactivityCloseBtn = document.getElementById('voiceInactivityCloseBtn');
        app.voiceInactivityContinueBtn = document.getElementById('voiceInactivityContinueBtn');

        app.hideVoiceInactivityModal = function () {
            if (!app.voiceInactivityModal) return;
            app.voiceInactivityModal.classList.add('hidden');
            app.voiceInactivityModal.classList.remove('flex');
        };

        app.showVoiceInactivityModal = function () {
            if (!app.voiceInactivityModal) return;
            app.voiceInactivityModal.classList.remove('hidden');
            app.voiceInactivityModal.classList.add('flex');
        };

        if (app.voiceInactivityCloseBtn) {
            app.voiceInactivityCloseBtn.addEventListener('click', () => {
                if (typeof app.resumeFromInactivity === 'function') {
                    app.resumeFromInactivity();
                }
            });
        }
        if (app.voiceInactivityBackdrop) {
            app.voiceInactivityBackdrop.addEventListener('click', () => {
                if (typeof app.resumeFromInactivity === 'function') {
                    app.resumeFromInactivity();
                }
            });
        }
        if (app.voiceInactivityContinueBtn) {
            app.voiceInactivityContinueBtn.addEventListener('click', () => {
                if (typeof app.resumeFromInactivity === 'function') {
                    app.resumeFromInactivity();
                }
            });
        }
        // --- Loader & UI State Helpers ---
        app.showLoader = function () {
            if (app.chatLoader && app.chatMessages) {
                // Determine insertion point:
                // If there are messages, we want to be *after* the last one.
                // Just appending ensures it's at the visual bottom.
                // Note: insertMessageInOrder sorts by timestamp, so new real messages 
                // will arrive and sorted correctly. The loader is untimestamped/ephemeral.

                //app.chatMessages.appendChild(app.chatLoader);

                app.chatLoader.classList.remove('hidden');
                // Scroll to bottom
                const container = document.getElementById('chatContainer');
                if (container) {
                    container.scrollTop = container.scrollHeight;
                }
            }
        };

        app.hideLoader = function () {
            if (app.chatLoader) {
                app.chatLoader.classList.add('hidden');
            }
        };

        app.setMicButtonState = function (state) {
            // state: 'enabled' | 'disabled'
            if (!app.micToggleButton) return;

            if (state === 'disabled') {
                app.micToggleButton.setAttribute('disabled', 'true');
                app.micToggleButton.classList.add('mic-disabled', 'pointer-events-none', 'opacity-50', 'cursor-not-allowed');
            } else {
                app.micToggleButton.removeAttribute('disabled');
                app.micToggleButton.classList.remove('mic-disabled', 'pointer-events-none', 'opacity-50', 'cursor-not-allowed');
            }
        };

        app.setMicSpeakingAnimation = function (isSpeaking) {
            // Triggers the "speaking-pulse" on the mic button if desired
            if (!app.micToggleButton) return;

            if (isSpeaking) {
                app.micToggleButton.classList.add('speaking-pulse');
            } else {
                app.micToggleButton.classList.remove('speaking-pulse');
            }
        };
    }

    function updateTextButtonVisibility(app) {
        if (!app.textInput || !app.sendTextButton) return;
        const hasText = app.textInput.value.trim().length > 0;

        if (hasText) {
            app.sendTextButton.disabled = false;
            app.sendTextButton.classList.remove('opacity-50');
            app.sendTextButton.classList.add('text-supportiveColor');
        } else {
            app.sendTextButton.disabled = true;
            app.sendTextButton.classList.add('opacity-50');
            app.sendTextButton.classList.remove('text-teal-600');
        }
    }

    function updateMicToggleVisibility(app) {
        // In the new UI, the mic button is always visible but might change state
        // If we want to hide it when not connected, we can:
        if (!app.micToggleButton) return;
        // logic to hide/show if needed, for now keep visible
    }

    function hideSpeedControlsForGuests(app) {
        // Check if user has a userId (from URL or potentially from cache/localStorage)
        const userId = typeof app.getUserIdFromURL === 'function' ? app.getUserIdFromURL() : null;

        // If no userId found, hide the voice speed section
        if (!userId && app.voiceSpeedSection) {
            app.voiceSpeedSection.style.display = 'none';
        }
    }

    function setCallModePanelOpen(app, open) {
        const panel = app.callModePanel;
        if (!panel) return;

        panel.classList.toggle('opacity-0', !open);
        panel.classList.toggle('translate-y-10', !open);
        panel.classList.toggle('opacity-100', open);
        panel.classList.toggle('translate-y-0', open);

        // Critical: actually show/hide the element and enable interaction
        if (open) {
            panel.classList.remove('hidden');
            panel.classList.add('flex', 'pointer-events-auto');
            panel.classList.remove('pointer-events-none');
            panel.style.zIndex = '55'; // Boost above inputWrapper (z-40)
            if (typeof messageToApp === 'function') {
                const thumb = app.currentVoiceThumbUrl || null;
                const thumbAbsolute = thumb && !thumb.startsWith('http')
                    ? new URL(thumb, window.location.origin).href
                    : thumb;
                messageToApp({
                    action: 'ericaDetailsPage',
                    coach: app.selectedCompanionId || null,
                    coachImage: thumbAbsolute
                });
            }
        } else {
            // Delay adding 'hidden' to allow transition to finish
            setTimeout(() => {
                if (panel.classList.contains('opacity-0')) {
                    panel.classList.add('hidden');
                    panel.classList.remove('flex', 'pointer-events-auto');
                    panel.classList.add('pointer-events-none');
                }
            }, 300);
        }

        // Ensure the chat has enough bottom padding so messages don't sit behind the panel
        const chatContainer = document.getElementById('chatContainer');
        if (chatContainer) {
            chatContainer.classList.toggle('call-panel-open', !!open);
        }

        if (open) {
            try {
                // Helpers/Logic reused from renderCoachList to ensure consistency
                const normalizeIdleVideoPath = (path) => {
                    if (!path || typeof path !== 'string') return null;
                    const t = path.trim();
                    if (!t) return null;
                    // Note: app.apiUrl might not be available in all contexts, but is fine here
                    if (typeof app?.apiUrl === 'function') {
                        if (t.startsWith('/companions/')) return app.apiUrl(t);
                        if (t.startsWith('companions/')) return app.apiUrl('/' + t);
                    }
                    return t;
                };

                const toTitleCase = (value) => {
                    const s = String(value || '').trim();
                    if (!s) return '';
                    return s.charAt(0).toUpperCase() + s.slice(1);
                };

                // Build candidates based on profile
                const buildCandidates = (type) => { // type: 'idle', 'speaking', 'waving'
                    const profile = app.currentVoiceProfile || {};
                    const raw = [];
                    // Priority: Explicit path in profile (if matches type), companionId, id, character, selectedVoice

                    // 1. Explicit path overrides
                    // We include ALL known video paths as seeds, because we can derive speaking from idle, etc.
                    if (profile.idleVideo) raw.push(profile.idleVideo);
                    if (profile.speakingVideo) raw.push(profile.speakingVideo);
                    if (profile.wavingVideo) raw.push(profile.wavingVideo);

                    // 2. Name based candidates
                    raw.push(profile.companionId, profile.id, profile.character, app.selectedVoice);

                    const items = [];
                    raw.forEach((val) => {
                        if (!val || typeof val !== 'string') return;
                        const cleaned = val.trim();
                        if (!cleaned) return;

                        // Check if it's a full path (from explicit override)
                        if (cleaned.includes('/') || cleaned.includes('.')) {
                            // Fix up path to ensure 84p if it's a standard companion path
                            let p = cleaned;
                            if (p.includes('/idle/') && !p.includes('/84p/')) p = p.replace('/idle/', '/idle/84p/');
                            if (p.includes('/speaking/') && !p.includes('/84p/')) p = p.replace('/speaking/', '/speaking/84p/');
                            if (p.includes('/waving/') && !p.includes('/84p/')) p = p.replace('/waving/', '/waving/84p/');

                            // If we are looking for 'speaking' but got an 'idle' path, swap it
                            if (type === 'speaking' && p.includes('/idle/')) p = p.replace('/idle/', '/speaking/');
                            if (type === 'waving' && p.includes('/idle/')) p = p.replace('/idle/', '/waving/');

                            items.push(p);
                            return;
                        }

                        // It's a name, generate paths
                        items.push(cleaned);
                        const firstToken = cleaned.split(' ')[0];
                        if (firstToken && firstToken !== cleaned) items.push(firstToken);
                        const title = toTitleCase(firstToken || cleaned);
                        if (title && title !== cleaned) items.push(title);
                    });

                    const unique = Array.from(new Set(items.filter(Boolean)));
                    // Map names to full paths
                    return unique.map(v => {
                        if (v.includes('/')) return normalizeIdleVideoPath(v.replace('.mp4', '.webm'));
                        return normalizeIdleVideoPath(`companions/${type}/84p/${encodeURIComponent(v)}.webm`);
                    }).filter(Boolean);
                };

                const idleCandidates = buildCandidates('idle');
                const speakingCandidates = buildCandidates('speaking');
                const waveCandidates = buildCandidates('waving');

                // Try candidates function
                const tryLoadVideo = (videoEl, candidates, onAllFailed) => {
                    if (!videoEl || !candidates || candidates.length === 0) {
                        if (onAllFailed) onAllFailed();
                        return;
                    }
                    let idx = 0;
                    const tryNext = () => {
                        if (idx >= candidates.length) {
                            if (onAllFailed) onAllFailed();
                            return;
                        }
                        const src = candidates[idx++];
                        videoEl.src = src;
                        // console.log(`[Erica] Trying ${videoEl.className} candidate: ${src}`);
                    };

                    videoEl.onerror = () => {
                        // console.warn(`[Erica] Failed to load video: ${videoEl.src}`);
                        tryNext();
                    };

                    // Reset error handler when successful (optional, but good practice)
                    videoEl.oncanplay = () => {
                        videoEl.onerror = null;
                        // Video loaded successfully
                    };

                    tryNext();
                };

                // 1. IDLE VIDEO
                if (app.callModeAvatarVideo) {
                    app.callModeAvatarVideo.style.display = 'block';
                    if (app.callModeAvatarImg) app.callModeAvatarImg.style.display = 'none';

                    tryLoadVideo(app.callModeAvatarVideo, idleCandidates, () => {
                        // Fallback to image if all videos fail
                        app.callModeAvatarVideo.style.display = 'none';
                        if (app.callModeAvatarImg) app.callModeAvatarImg.style.display = 'block';
                    });
                }

                // 2. SPEAKING VIDEO
                if (app.callModeSpeakingVideo) {
                    app.callModeSpeakingVideo.style.display = 'none';
                    tryLoadVideo(app.callModeSpeakingVideo, speakingCandidates, () => {
                        console.log('[Erica] No speaking video available after trying candidates.');
                    });
                }

                // 3. WAVE VIDEO
                if (app.callModeWaveVideo) {
                    app.callModeWaveVideo.style.display = 'none';
                    tryLoadVideo(app.callModeWaveVideo, waveCandidates, () => {
                        console.log('[Erica] No wave video available.');
                    });

                    app.callModeWaveVideo.onended = () => {
                        app.callModeWaveVideo.style.display = 'none';
                        if (app.callModeAvatarVideo) app.callModeAvatarVideo.style.display = 'block';
                        // Reset speaking video
                        if (app.callModeSpeakingVideo) {
                            app.callModeSpeakingVideo.style.display = 'none';
                            app.callModeSpeakingVideo.style.opacity = '0';
                        }
                    };
                }

                // Set image as fallback
                const imgSrc = app.currentVoiceThumbUrl ||
                    (app.currentVoiceThumb ? app.currentVoiceThumb.src : null);
                if (imgSrc && app.callModeAvatarImg) {
                    app.callModeAvatarImg.src = imgSrc;
                }
            } catch (_) { }

            updateCallPanelSpeakerUI(app);
            updateCallPanelMicUI(app);

            // Nudge scroll to bottom so the most recent message stays visible above the panel
            if (chatContainer) {
                setTimeout(() => {
                    try {
                        chatContainer.scrollTop = chatContainer.scrollHeight;
                    } catch (_) { }
                }, 0);
            }
        }

        // While in-call panel is open, hide the floating mic FAB to avoid duplicate controls.
        if (app.micToggleButton) {
            app.micToggleButton.classList.toggle('hidden', !!open);
        }

        // Disable back button and switch coaching style button during voice mode
        if (app.backToCoachListBtn) {
            app.backToCoachListBtn.disabled = !!open;
            app.backToCoachListBtn.classList.toggle('opacity-50', !!open);
            app.backToCoachListBtn.classList.toggle('cursor-not-allowed', !!open);
            app.backToCoachListBtn.classList.toggle('pointer-events-none', !!open);
        }
        if (app.menuSwitchCoachingStyle) {
            app.menuSwitchCoachingStyle.disabled = !!open;
            app.menuSwitchCoachingStyle.classList.toggle('opacity-50', !!open);
            app.menuSwitchCoachingStyle.classList.toggle('cursor-not-allowed', !!open);
            app.menuSwitchCoachingStyle.classList.toggle('pointer-events-none', !!open);
        }
    }

    function isMoreMenuOpen(app) {
        if (!app || !app.moreMenu) return false;
        return !app.moreMenu.classList.contains('hidden');
    }

    function setMoreMenuOpen(app, open) {
        if (!app || !app.moreMenu) return;
        app.moreMenu.classList.toggle('hidden', !open);
        if (app.moreMenuBtn) {
            app.moreMenuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
        if (open) updateMoreMenuSpeedChecks(app);
    }

    function updateMoreMenuSpeedChecks(app) {
        if (!app || !app.menuSpeedItems || app.menuSpeedItems.length === 0) return;
        const raw = app.currentVoiceProfile ? app.currentVoiceProfile.voiceSpeed : null;
        const current = typeof app.normalizeSpeedValue === 'function' ? app.normalizeSpeedValue(raw) : (raw || '1x');
        app.menuSpeedItems.forEach((btn) => {
            const speed = btn.getAttribute('data-speed');
            const check = btn.querySelector('.menuCheck');
            const isActive = speed === current;
            btn.classList.toggle('bg-gray-100', isActive);
            btn.classList.toggle('font-medium', isActive);
            if (check) check.classList.toggle('hidden', !isActive);
        });
    }

    function updateCallPanelSpeakerUI(app) {
        const enabled = !!app.isSoundEnabled;
        if (app.callSpeakerOnIcon) app.callSpeakerOnIcon.classList.toggle('hidden', !enabled);
        if (app.callSpeakerOffIcon) app.callSpeakerOffIcon.classList.toggle('hidden', enabled);
        if (app.callSpeakerBtn) {
            app.callSpeakerBtn.setAttribute('aria-label', enabled ? 'Mute speaker' : 'Unmute speaker');
        }
    }

    function updateSpeakerLevel(app, level = 0) {
        if (!app.callSpeakerBtn) return;
        const clamped = Math.max(0, Math.min(1, level || 0));
        const scale = (1 + clamped * 0.25).toFixed(3);
        const glow = Math.round(6 + clamped * 14);
        //app.callSpeakerBtn.style.setProperty('--speaker-scale', scale);
        //app.callSpeakerBtn.style.setProperty('--speaker-glow', `${glow}px`);
        //app.callSpeakerBtn.classList.toggle('speaker-active', clamped > 0.04 && !!app.isSoundEnabled);

        if (app.centerCoachAvatar) {
            app.centerCoachAvatar.classList.toggle('coach-speaking', clamped > 0.04 && !!app.isSoundEnabled);
        }

        // Voice bars replaced by a gentle colour shift on the speaker button
        // itself (subtler, matches the flat design of the compact controls
        // bar). Bars kept hidden regardless of state.
        if (app.voiceBars) {
            app.voiceBars.style.display = 'none';
        }
        if (app.callSpeakerBtn) {
            const isSpeaking = clamped > 0.04 && !!app.isSoundEnabled;
            app.callSpeakerBtn.style.color = isSpeaking ? 'rgb(20, 184, 166)' : '';
            app.callSpeakerBtn.style.background = isSpeaking ? 'rgba(20, 184, 166, 0.12)' : '';
        }

        // Smooth fade transitions for speaking video with delayed hiding
        if (app.callModeSpeakingVideo) {
            // Priority: If wave is playing, don't show speaking video
            if (app.callModeWaveVideo && app.callModeWaveVideo.style.display !== 'none') {
                return;
            }

            const shouldShowSpeaking = clamped > 0.04 && !!app.isSoundEnabled;

            if (shouldShowSpeaking) {
                // Clear any pending hide timeout
                if (app._speakingVideoHideTimeout) {
                    clearTimeout(app._speakingVideoHideTimeout);
                    app._speakingVideoHideTimeout = null;
                }

                // Show speaking video with fade-in
                if (app.callModeSpeakingVideo.style.display === 'none') {
                    app.callModeSpeakingVideo.style.display = 'block';
                    // Ensure video is playing (browser might pause hidden videos)
                    app.callModeSpeakingVideo.play().catch(() => { });
                    // Force reflow to ensure transition works
                    app.callModeSpeakingVideo.offsetHeight;
                }
                app.callModeSpeakingVideo.style.opacity = '0.95';
            } else {
                // Fade out speaking video
                app.callModeSpeakingVideo.style.opacity = '0';

                // Delay hiding to allow fade-out and prevent choppy short pauses
                // Clear any existing timeout
                if (app._speakingVideoHideTimeout) {
                    clearTimeout(app._speakingVideoHideTimeout);
                }

                // Wait 500ms (fade duration + tolerance) before hiding
                app._speakingVideoHideTimeout = setTimeout(() => {
                    if (app.callModeSpeakingVideo && app.callModeSpeakingVideo.style.opacity === '0') {
                        app.callModeSpeakingVideo.style.display = 'none';
                    }
                    app._speakingVideoHideTimeout = null;
                }, 500);
            }
        }

        // Also animate the coach-list speaker icon for the active preview (if any)
        const previewId = app.currentPreviewCompanionId || null;
        const previewButtons = document.querySelectorAll('.audio-preview-btn');
        previewButtons.forEach((btn) => {
            const id = btn.getAttribute('data-companion-id') || null;
            const isActive = !!previewId && id === previewId && !!app.isSoundEnabled;
            if (isActive) {
                const opacity = (0.5 + clamped * 0.5).toFixed(3);
                btn.style.setProperty('--preview-opacity', opacity);
                btn.style.setProperty('--preview-glow', `${glow}px`);
                btn.style.setProperty('--preview-color', 'rgb(16, 185, 129)');
                btn.classList.toggle('speaker-active', clamped > 0.04);
            } else {
                btn.style.setProperty('--preview-opacity', '1');
                btn.style.setProperty('--preview-glow', '0px');
                btn.style.setProperty('--preview-color', '');
                btn.classList.remove('speaker-active');
            }
        });
    }

    function playCallModeWave(app) {
        if (!app || !app.callModeWaveVideo) return;

        if (app.callModeWaveVideo.readyState < 2) {
            console.warn('[Erica] Wave video not ready yet');
            return;
        }

        console.log('[Erica] Playing wave animation');

        // Hide idle and speaking videos completely
        if (app.callModeAvatarVideo) {
            app.callModeAvatarVideo.style.display = 'none';
        }
        if (app.callModeSpeakingVideo) {
            app.callModeSpeakingVideo.style.display = 'none';
        }

        // Show and play wave video
        app.callModeWaveVideo.style.display = 'block';
        app.callModeWaveVideo.currentTime = 0;
        app.callModeWaveVideo.play().catch((error) => {
            console.error('[Erica] Error playing wave video:', error);
            // Restore idle video on error
            if (app.callModeAvatarVideo) {
                app.callModeAvatarVideo.style.display = 'block';
            }
        });
    }

    function updateMicLevel(app, level = 0) {
        if (!app.callMicMuteBtn && !app.micToggleButton) return;

        const clamped = Math.max(0, Math.min(1, level || 0));
        const scale = (1 + clamped * 0.15).toFixed(3);
        const glow = Math.round(4 + clamped * 12);

        // Update call mode mic button if it exists
        if (app.callMicMuteBtn) {
            app.callMicMuteBtn.style.setProperty('--mic-scale', scale);
            app.callMicMuteBtn.style.setProperty('--mic-glow', `${glow}px`);
            app.callMicMuteBtn.classList.toggle('mic-speaking', clamped > 0.04);
        }

        // Update floating mic FAB if it exists and is visible
        if (app.micToggleButton && !app.micToggleButton.classList.contains('hidden')) {
            app.micToggleButton.style.setProperty('--mic-scale', scale);
            app.micToggleButton.style.setProperty('--mic-glow', `${glow}px`);
            app.micToggleButton.classList.toggle('mic-speaking', clamped > 0.04);
        }
    }

    function updateCallPanelMicUI(app) {
        const muted = !!app.isSelfMuted;
        if (app.callMicOnIcon) app.callMicOnIcon.classList.toggle('hidden', muted);
        if (app.callMicOffIcon) app.callMicOffIcon.classList.toggle('hidden', !muted);
        if (app.callMicMuteBtn) {
            app.callMicMuteBtn.setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone');
        }
    }

    function setMicToggleUI(app, isEnabled) {
        if (!app.micToggleButton) return;

        const btn = app.micToggleButton;
        const icon = app.micIcon;
        const ripple = app.micRipple;

        if (isEnabled) {
            // Active Recording State
            btn.classList.add('mic-active'); // Triggers red pulse animation from CSS

            // Keep icon stable; stop button lives in call panel now.
            if (icon) {
                icon.classList.remove('scale-0', 'opacity-0');
                icon.classList.add('scale-100', 'opacity-100');
            }
            if (ripple) {
                ripple.classList.remove('opacity-0', 'scale-75'); // animate ripple
                ripple.classList.add('animate-ping', 'opacity-30');
            }

        } else {
            // Idle State
            btn.classList.remove('mic-active');

            if (icon) {
                icon.classList.remove('scale-0', 'opacity-0');
                icon.classList.add('scale-100', 'opacity-100');
            }
            if (ripple) {
                ripple.classList.add('opacity-0', 'scale-75');
                ripple.classList.remove('animate-ping', 'opacity-30');
            }
        }

        // Show/hide the in-call panel with the same source of truth as the mic state.
        setCallModePanelOpen(app, !!isEnabled);
    }

    function updateStatusDot(app, statusOrConnected) {
        // Normalize input: true -> 'connected', false -> 'disconnected', string -> string
        let state = 'disconnected';
        if (statusOrConnected === true || statusOrConnected === 'connected') state = 'connected';
        else if (statusOrConnected === 'connecting') state = 'connecting';
        else if (statusOrConnected === 'onhold') state = 'onhold';
        else state = 'disconnected';

        // Connection loader overlay — show when connecting/disconnected, hide when connected/onhold
        const connectionLoader = document.getElementById('connectionLoader');
        if (connectionLoader) {
            if (state === 'connecting' || state === 'disconnected') {
                connectionLoader.classList.remove('hidden');
            } else {
                connectionLoader.classList.add('hidden');
            }
        }

        // Header Status
        if (app.connectionStatusDot) {
            // Reset base classes
            app.connectionStatusDot.classList.remove('bg-gray-300', 'bg-green-500', 'bg-yellow-500', 'bg-orange-400', 'shadow-[0_0_8px_rgba(34,197,94,0.6)]', 'animate-pulse');

            if (state === 'connected') {
                app.connectionStatusDot.classList.add('bg-green-500', 'shadow-[0_0_8px_rgba(34,197,94,0.6)]');
            } else if (state === 'connecting') {
                app.connectionStatusDot.classList.add('bg-yellow-500', 'animate-pulse');
            } else if (state === 'onhold') {
                app.connectionStatusDot.classList.add('bg-orange-400', 'animate-pulse');
            } else {
                app.connectionStatusDot.classList.add('bg-gray-300');
            }
        }

        if (app.connectionStatusText) {
            if (state === 'connected') {
                app.connectionStatusText.textContent = 'Connected';
                app.connectionStatusText.classList.remove('text-yellow-600', 'text-gray-500', 'text-orange-500');
                app.connectionStatusText.classList.add('text-green-600', 'opacity-100');
                app.connectionStatusText.classList.remove('opacity-0');
            } else if (state === 'connecting') {
                app.connectionStatusText.textContent = 'Connecting...';
                app.connectionStatusText.classList.remove('text-green-600', 'text-gray-500', 'text-orange-500');
                app.connectionStatusText.classList.add('text-yellow-600', 'opacity-100');
                app.connectionStatusText.classList.remove('opacity-0');
            } else if (state === 'onhold') {
                app.connectionStatusText.textContent = 'On Hold';
                app.connectionStatusText.classList.remove('text-teal-600', 'text-green-600', 'text-yellow-600', 'text-gray-500');
                app.connectionStatusText.classList.add('text-orange-500', 'opacity-100');
                app.connectionStatusText.classList.remove('opacity-0');
            } else {
                app.connectionStatusText.textContent = 'Disconnected';
                app.connectionStatusText.classList.remove('text-teal-600', 'text-green-600', 'text-yellow-600', 'opacity-100');
                //app.connectionStatusText.classList.add('text-gray-500', 'opacity-0');
                app.connectionStatusText.classList.add('text-gray-500');
            }
        }
    }

    function insertMessageInOrder(app, newElement, message) {
        if (!app.chatMessages) return;

        // Ensure timestamp attribute is up to date
        const newTs = message.timestamp || Date.now();
        newElement.setAttribute('data-timestamp', newTs);

        // If element is already in DOM, remove it if we want to re-sort (optional, but safer)
        // For now, only insert if not present to avoid jitter, as timestamps don't tend to change radically.
        // If element is already in DOM, continue logic to check if it needs moving (re-sorting)
        // This ensures backdated user messages jump above bot responses even after initial insertion.
        // if (newElement.parentNode === app.chatMessages) return;

        // Find insertion point
        const children = Array.from(app.chatMessages.children);
        let inserted = false;

        // Iterate backwards might be faster if appending to end usually, 
        // but iterating forwards is safer for "insert before first item that is NEWER"
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (child === newElement) continue;

            const childTs = parseInt(child.getAttribute('data-timestamp') || '0');

            // If child is newer than newElement, insert newElement BEFORE child
            // (Oldest at top, Newest at bottom)
            if (childTs > newTs) {
                app.chatMessages.insertBefore(newElement, child);
                inserted = true;
                break;
            }
        }

        if (!inserted) {
            app.chatMessages.appendChild(newElement);
        }

        // Scroll to bottom
        const container = document.getElementById('chatContainer');
        if (container) {
            container.scrollTop = container.scrollHeight;
        }
    }

    // function formatText(text) {
    //     if (!text) return '';

    //     // 1. Escape HTML to prevent XSS
    //     let html = text
    //         .replace(/&/g, '&amp;')
    //         .replace(/</g, '&lt;')
    //         .replace(/>/g, '&gt;');

    //     // 2. Clickable links: https://... or http://...
    //     html = html.replace(/https?:\/\/[^\s<>"]+/g, url => {
    //         const href = url.replace(/&amp;/g, '&');
    //         return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="font-medium underline">${url}</a>`;
    //     });

    //     // 3. Bold: **text**
    //     html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    //     // 4. Italic: *text* or _text_
    //     html = html.replace(/\*(?!\*)(.*?)\*(?!\*)/g, '<em>$1</em>');

    //     // 5. Process line by line to group list items
    //     const lines = html.split('\n');
    //     const result = [];
    //     let inUl = false;
    //     let inOl = false;

    //     for (const line of lines) {
    //         const ulMatch = line.match(/^[\-\*] (.+)$/);   // - item or * item
    //         const olMatch = line.match(/^\d+\. (.+)$/);    // 1. item

    //         if (ulMatch) {
    //             if (inOl) { result.push('</ol>'); inOl = false; }
    //             if (!inUl) { result.push('<ul class="list-disc pl-7 my-1 space-y-0.5">'); inUl = true; }
    //             result.push(`<li>${ulMatch[1]}</li>`);
    //         } else if (olMatch) {
    //             if (inUl) { result.push('</ul>'); inUl = false; }
    //             if (!inOl) { result.push('<ol class="list-decimal pl-7 my-1 space-y-0.5">'); inOl = true; }
    //             result.push(`<li>${olMatch[1]}</li>`);
    //         } else {
    //             if (inUl) { result.push('</ul>'); inUl = false; }
    //             if (inOl) { result.push('</ol>'); inOl = false; }
    //             result.push(line === '' ? '<br>' : `<span>${line}</span>`);
    //         }
    //     }

    //     // Close any open list
    //     if (inUl) result.push('</ul>');
    //     if (inOl) result.push('</ol>');

    //     return result.join('');
    // }

    function formatText(text) {
        if (!text) return '';

        // 1. Escape HTML to prevent XSS
        let html = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // 2. Clickable links — exclude trailing punctuation like ] ) . ,
        html = html.replace(/https?:\/\/[^\s<>"[\]()]+/g, url => {
            const href = url.replace(/&amp;/g, '&');
            return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="font-medium underline">${url}</a>`;
        });

        // 3. Bold: **text**
        html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

        // 4. Italic: *text*
        html = html.replace(/\*(?!\*)(.*?)\*(?!\*)/g, '<em>$1</em>');

        // 5. Pre-normalize: merge empty numbered items with the next content line.
        //    AI sometimes sends "1.\n**Title**" instead of "1. **Title**".
        const splitLines = html.split('\n');
        const normalizedLines = [];
        for (let i = 0; i < splitLines.length; i++) {
            if (/^\d+\.\s*$/.test(splitLines[i].trim()) && i + 1 < splitLines.length) {
                // Find next non-empty line and merge with the number
                let j = i + 1;
                while (j < splitLines.length && splitLines[j].trim() === '') j++;
                if (j < splitLines.length) {
                    normalizedLines.push(splitLines[i].trim() + ' ' + splitLines[j].trim());
                    i = j; // skip the merged line
                    continue;
                }
            }
            normalizedLines.push(splitLines[i]);
        }

        // 6. Pre-scan: detect if numbered list items have description lines following them.
        //    Rule: use <ol> ONLY when all numbered items are standalone (no descriptions).
        //          Use <ul> for everything else — items with descriptions, or mixed content.
        //    A "description" is any non-empty, non-list line that immediately follows a numbered item.
        let numberedHasDescriptions = false;
        let lastWasNumbered = false;
        for (const line of normalizedLines) {
            const trimmed = line.trim();
            const isOlItem = /^\d+\. .+/.test(trimmed);
            const isAnyListItem = /^[\-\*] .+/.test(trimmed) || isOlItem;
            if (isOlItem) {
                lastWasNumbered = true;
            } else if (lastWasNumbered && trimmed !== '' && !isAnyListItem) {
                numberedHasDescriptions = true;
                break;
            } else if (trimmed !== '') {
                lastWasNumbered = false;
            }
        }

        // 7. Process line by line
        const lines = normalizedLines;
        const result = [];
        let inUl = false;
        let inOl = false;
        let paragraphLines = [];
        let lastListType = null;
        let inDescriptionMode = false; // true after a numbered list item when descriptions are expected

        const flushParagraph = () => {
            if (paragraphLines.length > 0) {
                result.push(`<span class="block mb-1">${paragraphLines.join('<br>')}</span>`);
                paragraphLines = [];
            }
        };

        const appendToLastLi = (extraText) => {
            for (let i = result.length - 1; i >= 0; i--) {
                if (result[i].startsWith('<li>')) {
                    result[i] = result[i].replace(/<\/li>$/, `<span class="block text-gray-500 text-sm font-normal">${extraText.trim()}</span></li>`);
                    return true;
                }
            }
            return false;
        };

        for (const line of lines) {
            const trimmed = line.trim();
            const ulMatch = trimmed.match(/^[\-\*] (.+)$/);
            const olMatch = trimmed.match(/^\d+\. (.+)$/);
            const isIndentedContinuation = line.match(/^\s{2,}/) && trimmed.length > 0 && !ulMatch && !olMatch;

            if (ulMatch) {
                flushParagraph();
                if (inOl) { result.push('</ol>'); inOl = false; }
                if (!inUl) { result.push('<ul class="list-disc pl-7 my-1 space-y-1">'); inUl = true; }
                result.push(`<li>${ulMatch[1].trim()}</li>`);
                lastListType = 'ul';
                inDescriptionMode = false;
            } else if (olMatch) {
                flushParagraph();
                if (inUl) { result.push('</ul>'); inUl = false; }
                if (numberedHasDescriptions) {
                    // Has descriptions → render as bullets
                    if (!inOl) { result.push('<ul class="list-disc pl-7 my-1 space-y-2">'); inOl = true; }
                } else {
                    // No descriptions → render as numbered
                    if (!inOl) { result.push('<ol class="list-decimal pl-7 my-1 space-y-0.5">'); inOl = true; }
                }
                result.push(`<li>${olMatch[1].trim()}</li>`);
                lastListType = 'ol';
                inDescriptionMode = numberedHasDescriptions; // expect description lines after this item
            } else if (trimmed === '') {
                inDescriptionMode = false;
                if (!inUl && !inOl) flushParagraph();
            } else if (isIndentedContinuation && lastListType) {
                // Explicitly indented continuation line
                appendToLastLi(trimmed);
            } else if (inDescriptionMode && lastListType === 'ol') {
                // Non-indented description line following a numbered item (AI format without indentation)
                appendToLastLi(trimmed);
            } else {
                if (inUl) { result.push('</ul>'); inUl = false; lastListType = null; }
                if (inOl) { result.push('</ol>'); inOl = false; lastListType = null; }
                inDescriptionMode = false;
                paragraphLines.push(trimmed);
            }
        }

        flushParagraph();
        if (inUl) result.push('</ul>');
        if (inOl) result.push('</ol>');

        return result.join('');
    }

    function updateMessageElement(app, message) {
        if (!app.chatMessages) return;

        // If final message has empty text (e.g. QC hid garbage), hide existing element or skip
        if (!message.text && message.final) {
            const existingDiv = app.messageElements.get(message.id);
            if (existingDiv) {
                existingDiv.style.display = 'none';
            }
            return;
        }

        // Hide summary/system messages from UI as requested
        if (message.role === 'system' || message.type === 'summary') return;

        let messageDiv = app.messageElements.get(message.id);

        if (!messageDiv) {
            messageDiv = document.createElement('div');
            messageDiv.setAttribute('data-message-id', message.id);
            messageDiv.setAttribute('data-timestamp', message.timestamp || Date.now()); // Add timestamp for sorting

            // Common Classes
            messageDiv.className = 'w-full flex animate-fade-in-up';

            // Inner content wrapper
            const contentWrapper = document.createElement('div');
            // Text element
            const p = document.createElement('p');

            // Chat is INVERTED from classic messenger layout:
            //   - Erica (bot): RIGHT side, near the persistent corner icon
            //   - User: LEFT side
            // Erica's bubble no longer carries an inline avatar — she IS the
            // corner icon on the parent page, so repeating a thumbnail per
            // bubble is redundant clutter.
            if (message.role === 'user') {
                messageDiv.classList.add('justify-start');
                contentWrapper.className = 'max-w-[80%] bg-lightGray backdrop-blur-sm border border-gray-100 rounded-2xl rounded-bl-md px-4 py-3 text-[14px] leading-relaxed text-gray-700 select-text';
                contentWrapper.appendChild(p);
                messageDiv.appendChild(contentWrapper);
            } else {
                messageDiv.classList.add('justify-end');
                contentWrapper.className = 'max-w-[80%] bg-primary text-white rounded-2xl rounded-br-md px-4 py-3 text-[14px] leading-relaxed select-text';
                contentWrapper.appendChild(p);
                messageDiv.appendChild(contentWrapper);
            }

            messageDiv._textElement = p;
            messageDiv._contentWrapper = contentWrapper;

            insertMessageInOrder(app, messageDiv, message);
            app.messageElements.set(message.id, messageDiv);
        }

        // Update Text
        const textElement = messageDiv._textElement;
        /*if (textElement) {
            textElement.textContent = message.text || '';
        }*/
        if (textElement) {
            if (message.final) {
                textElement.innerHTML = formatText(message.text || '');
            } else {
                textElement.textContent = message.text || ''; // plain during streaming
            }
        }

        // Typing Indicator logic (append to contentWrapper if needed)
        // (Simplified for now, can add back detailed pill logic if desired)
        if (!message.final && message.text) {
            // Optional: Add cursor/dots
        }
    }

    // --- Dynamic Render Logic ---
    function renderCoachList(app, companions, navigatorResult) {
        const listContainer = document.getElementById('coachList');
        if (!listContainer || !companions) return;

        // Cache last companions and navigator result for re-render (e.g., after rename)
        app.lastCompanions = companions;
        if (navigatorResult) app._lastNavigatorResult = navigatorResult;
        const navResult = navigatorResult || app._lastNavigatorResult || null;

        listContainer.innerHTML = ''; // Clear existing

        const normalizeThumb = (thumb) => {
            if (!thumb || typeof thumb !== 'string') return null;
            const t = thumb.trim();
            if (!t) return null;

            if (typeof app?.apiUrl === 'function') {
                // Extract /companions/... from any path (handles /agentErica/companions/... etc.)
                const compIdx = t.indexOf('/companions/');
                if (compIdx !== -1 && !t.startsWith('http')) {
                    return app.apiUrl(t.substring(compIdx));
                }
                if (t.startsWith('companions/')) return app.apiUrl('/' + t);
                if (t.startsWith('http://') || t.startsWith('https://')) {
                    try {
                        const u = new URL(t);
                        const ci = u.pathname.indexOf('/companions/');
                        if (ci !== -1) {
                            return app.apiUrl(u.pathname.substring(ci));
                        }
                    } catch (_) {
                        // ignore
                    }
                }
            }

            return t;
        };

        const normalizeIdleVideoPath = (path) => {
            if (!path || typeof path !== 'string') return null;
            const t = path.trim();
            if (!t) return null;
            if (typeof app?.apiUrl === 'function') {
                if (t.startsWith('/companions/')) return app.apiUrl(t);
                if (t.startsWith('companions/')) return app.apiUrl('/' + t);
            }
            return t;
        };

        const toTitleCase = (value) => {
            const s = String(value || '').trim();
            if (!s) return '';
            return s.charAt(0).toUpperCase() + s.slice(1);
        };

        const buildIdleVideoCandidates = (name, config, comp) => {
            const raw = [];
            raw.push(config?.character, config?.id, comp?.companionId, name);
            const items = [];
            raw.forEach((val) => {
                if (!val || typeof val !== 'string') return;
                const cleaned = val.trim();
                if (!cleaned) return;
                items.push(cleaned);
                const firstToken = cleaned.split(' ')[0];
                if (firstToken && firstToken !== cleaned) items.push(firstToken);
                const title = toTitleCase(firstToken || cleaned);
                if (title && title !== cleaned) items.push(title);
            });

            const unique = Array.from(new Set(items.filter(Boolean)));
            return unique.map(v => normalizeIdleVideoPath(`/companions/idle/84p/${encodeURIComponent(v)}.webm`)).filter(Boolean);
        };

        const buildWaveVideoCandidates = (name, config, comp) => {
            const raw = [];
            raw.push(config?.character, config?.id, comp?.companionId, name);
            const items = [];
            raw.forEach((val) => {
                if (!val || typeof val !== 'string') return;
                const cleaned = val.trim();
                if (!cleaned) return;
                items.push(cleaned);
                const firstToken = cleaned.split(' ')[0];
                if (firstToken && firstToken !== cleaned) items.push(firstToken);
                const title = toTitleCase(firstToken || cleaned);
                if (title && title !== cleaned) items.push(title);
            });

            const unique = Array.from(new Set(items.filter(Boolean)));
            const candidates = [];
            unique.forEach((v) => {
                candidates.push(normalizeIdleVideoPath(`/companions/waving/84p/${encodeURIComponent(v)}.webm`));
                candidates.push(normalizeIdleVideoPath(`/companions/waving/${encodeURIComponent(v)}.mp4`));
            });
            return candidates.filter(Boolean);
        };

        const buildThumbCandidates = (name, config, comp) => {
            const candidates = [];

            // Prefer explicit thumb from config (if server provides it)
            const explicit = normalizeThumb(config?.thumb);
            if (explicit) candidates.push(explicit);

            // Otherwise infer from known naming convention in /companions
            const baseName = (name || config?.id || comp?.companionId || '').toString().trim();
            const noSpace = baseName.replace(/\s+/g, '');
            const variants = Array.from(new Set([
                baseName,
                noSpace,
                baseName.toLowerCase(),
                noSpace.toLowerCase(),
                baseName.charAt(0).toUpperCase() + baseName.slice(1),
                (baseName.charAt(0).toUpperCase() + baseName.slice(1)).toLowerCase()
            ].filter(Boolean)));

            variants.forEach(v => {
                const file = `/companions/${encodeURIComponent(v)}-thumb.png`;
                if (typeof app?.apiUrl === 'function') {
                    candidates.push(app.apiUrl(file));
                } else {
                    candidates.push(file);
                }
            });

            // Deduplicate while keeping order
            return Array.from(new Set(candidates));
        };

        // Collect cards with their companionId for section-based rendering
        const allCards = [];

        companions.forEach(comp => {
            const config = comp.configuration || {};
            const nameKey = (comp.companionId || config.id || config.character || '').toString();
            let storedName = null;
            try {
                const key = `ERICA_COACH_NAME_${nameKey.toLowerCase()}`;
                storedName = window.localStorage?.getItem(key) || null;
                // Fix: Ignore cached "coach" or "Coach" to prevent generic name override
                if (storedName && storedName.toLowerCase() === 'coach') {
                    storedName = null;
                }
            } catch (_) { }
            const name = storedName || config.character || config.id || comp.companionId || 'Coach';
            // Badge should be the short coaching-style key (e.g., "Supportive"), not the descriptive label.
            // In your data:
            // - `id` / `companionId` => short
            // - `label` => longer description (e.g., "Calm, Reassuring Coach")
            let role = config.id || config.companionId || comp.companionId || config.role || 'Coach';
            if (typeof role === 'string' && role.length > 48) {
                role = comp.companionId || config.id || 'Coach';
            }
            const subtitleText = (config.label && config.label !== role) ? config.label : '';
            const voice = config.openaiVoice || '';
            const companionId = comp.companionId || config.companionId || config.id || config.character || null;
            const fullDesc = config.userFacingContext || '';
            const firstSentence = fullDesc.split('.')[0];
            const shortDesc = (firstSentence ? firstSentence : fullDesc) ? ((firstSentence ? firstSentence : fullDesc).trim() + (fullDesc.includes('.') ? '.' : '')) : '';
            const initials = name.substring(0, 1).toUpperCase();

            // Colors based on name (hashing or simple rotation)
            const bgColors = ['bg-teal-400', 'bg-directiveColor', 'bg-exploratoryColor', 'bg-cyan-400', 'bg-guidanceColor'];
            const colorIndex = (name.charCodeAt(0) + name.length) % bgColors.length;
            const avatarColor = bgColors[colorIndex];

            // Role Badge Color (Optional: vary by role)
            let roleColor = "bg-teal-100 text-teal-700";
            if (role === 'Supportive') {
                roleColor = "bg-supportiveColor text-white";
                roleType = "supportiveColor";
            }
            if (role === 'Directive') {
                roleColor = "bg-directiveColor text-white";
                roleType = "directiveColor";
            }
            if (role === 'Exploratory') {
                roleColor = "bg-exploratoryColor text-white";
                roleType = "exploratoryColor";
            }
            if (role === 'Guidance') {
                roleColor = "bg-guidanceColor text-white";
                roleType = "guidanceColor";
            }
            if (role === 'Discovery') {
                roleColor = "bg-discoveryColor text-white";
                roleType = "discoveryColor";
            }
            if (role === 'Empowering') {
                roleColor = "bg-empoweringColor text-white";
                roleType = "empoweringColor";
            }
            if (role == 'Strengths') {
                roleColor = "bg-strengthsColor text-white";
                roleType = "strengthsColor";
            }
            if (role == 'Nurturing') {
                roleColor = "bg-nurturingColor text-white";
                roleType = "nurturingColor";
            }
            if (role == 'Observational') {
                roleColor = "bg-observationalColor text-white";
                roleType = "observationalColor";
            }

            // Check if this coach is currently selected
            const isCurrentCoach = app.selectedCompanionId === companionId ||
                (app.selectedVoice === voice && !app.selectedCompanionId);

            // Card HTML
            const card = document.createElement('div');
            // Add active styling if this is the current coach
            const activeClass = isCurrentCoach ? ' active-coach' : '';
            card.className = `coachListItem bg-white rounded-2xl border-2 border-borderColor p-4 shadow-sm w-full transition-all duration-200 hover:shadow-md${activeClass} ${roleType}`;
            card.setAttribute('data-companion-id', companionId || '');
            card.setAttribute('data-voice', voice || '');

            const thumbCandidates = buildThumbCandidates(name, config, comp);
            const initialThumb = thumbCandidates[0] || '';

            card.innerHTML = `
                    <div class="flex items-start justify-between gap-3">
                        <!-- Left: Avatar -->
                        <div class="w-[48px] h-[48px] flex-shrink-0 rounded-full shadow-sm bg-white border border-gray-100 flex items-center justify-center">
                            <div class="w-[48px] h-[48px] rounded-full overflow-hidden flex items-center justify-center bg-white relative">
                                <video class="coach-idle-video coach-media absolute inset-0 w-full h-full object-cover" autoplay muted loop playsinline preload="auto" style="display:none;"></video>
                                <video class="coach-wave-video coach-media absolute inset-0 w-full h-full object-cover" muted playsinline preload="metadata" style="display:none;"></video>
                                <img class="coach-thumb coach-media w-full h-full object-cover" alt="${name}" referrerpolicy="no-referrer" loading="eager" src="${initialThumb}">
                                <div class="coach-initials absolute inset-0 ${avatarColor} flex items-center justify-center text-white font-bold text-xl" style="display:none;">
                                    ${initials}
                                </div>
                            </div>
                        </div>
                        
                        <!-- Middle: Info -->
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-1.5 mb-1 flex-wrap">
                                <h3 class="text-base font-semibold text-gray-900">${name}</h3>
                                ${isCurrentCoach ? '<span class="text-[10px] text-primary font-medium whitespace-nowrap">● Active</span>' : ''}
                            </div>
                            <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${roleColor}">
                                ${role}
                            </span>
                        </div>
                        
                        <!-- Right: Connect Button -->
                        <button class="connect-action-btn flex items-center gap-1 px-2.5 py-1 rounded-full border border-gray-300 text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors group cursor-pointer" data-voice="${voice}">
                            ${isCurrentCoach ? 'Resume' : 'Connect'}
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-iconColor group-hover:text-gray-600">
                                <polyline points="9 18 15 12 9 6"></polyline>
                            </svg>
                        </button>
                    </div>
                    
                    <!-- Info Row -->
                    <div class="mt-1 flex items-start gap-1.5">
                        <button class="info-toggle-btn text-gray-400 hover:text-gray-600 transition-colors text-iconColor border-borderColor border rounded-full w-[24px] h-[24px] hover:bg-lightGray" title="More Info">
                            <svg class="m-auto" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="12" cy="12" r="10"></circle>
                                <line x1="12" y1="16" x2="12" y2="12"></line>
                                <line x1="12" y1="8" x2="12.01" y2="8"></line>
                            </svg>
                        </button>
                        <button type="button" class="audio-preview-btn text-gray-400 hover:text-gray-600 transition-colors text-iconColor border-borderColor border rounded-full w-[24px] h-[24px] hover:bg-lightGray" title="Audio Preview" aria-label="Audio preview">
                            <span class="preview-icon inline-flex">
                                <svg cclass="m-auto" lass="speaker-anim" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                                    <path d="M19.364 18.364a9 9 0 0 0 0-12.728"></path>
                                </svg>
                            </span>
                            <span class="preview-spinner hidden inline-flex">
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" class="animate-spin">
                                    <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" opacity="0.25"></circle>
                                    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
                                </svg>
                            </span>
                        </button>
                        <p class="text-sm text-gray-500 leading-snug flex-1 mt-0.5 pl-1">${subtitleText || shortDesc}</p>
                    </div>
                    
                    <!-- Expanded Info (Hidden) -->
                    <div class="details-panel hidden mt-3 p-2.5 rounded-xl border-l-4 border-teal-400 text-sm text-gray-700 italic leading-relaxed animate-fade-in bg-lightGray/50">
                        ${fullDesc}
                    </div>
                `;

            // Avatar fallback: try multiple candidate thumb files, then fall back to initials
            const thumbImg = card.querySelector('.coach-thumb');
            const initialsOverlay = card.querySelector('.coach-initials');
            const idleVideo = card.querySelector('.coach-idle-video');
            const waveVideo = card.querySelector('.coach-wave-video');
            if (thumbImg) {
                // Store candidate list so we can try alternate casing (e.g., Omar vs omar)
                thumbImg._candidates = thumbCandidates;
                thumbImg._candidateIdx = 0;

                thumbImg.onerror = () => {
                    const list = Array.isArray(thumbImg._candidates) ? thumbImg._candidates : [];
                    const nextIdx = (thumbImg._candidateIdx || 0) + 1;
                    if (nextIdx < list.length) {
                        thumbImg._candidateIdx = nextIdx;
                        thumbImg.src = list[nextIdx];
                        return;
                    }
                    // No more candidates -> show initials
                    thumbImg.style.display = 'none';
                    if (initialsOverlay) initialsOverlay.style.display = 'flex';
                };
            }

            /*const showThumb = () => {
                if (thumbImg && thumbImg.style.display !== 'none') {
                    // keep thumb visible if it loaded
                } else if (initialsOverlay) {
                    initialsOverlay.style.display = 'flex';
                }
            };*/
            const showThumb = () => {
                if (thumbImg) {
                    thumbImg.style.display = 'block';
                    if (idleVideo) idleVideo.style.display = 'none';
                    if (initialsOverlay) initialsOverlay.style.display = 'none';
                } else if (initialsOverlay) {
                    initialsOverlay.style.display = 'flex';
                }
            };

            if (idleVideo) {
                const idleCandidates = buildIdleVideoCandidates(name, config, comp);
                let idleIdx = 0;

                const showVideo = () => {
                    idleVideo.style.display = 'block';
                    if (thumbImg) thumbImg.style.display = 'none';
                    if (initialsOverlay) initialsOverlay.style.display = 'none';
                };

                const tryNextIdle = () => {
                    if (!idleCandidates || idleIdx >= idleCandidates.length) {
                        idleVideo.style.display = 'none';
                        showThumb();
                        return;
                    }
                    idleVideo.src = idleCandidates[idleIdx++];
                    idleVideo.load();
                };

                idleVideo.addEventListener('canplay', () => {
                    showVideo();
                    idleVideo.play().catch(() => {
                        showThumb();
                    });
                }, { once: true });

                idleVideo.addEventListener('error', () => {
                    tryNextIdle();
                });

                tryNextIdle();
            }

            if (waveVideo) {
                const waveCandidates = buildWaveVideoCandidates(name, config, comp);
                let waveIdx = 0;
                let waveReady = false;
                let wavePlaying = false;
                let hoverTimer = null;
                let hovered = false;

                const tryNextWave = () => {
                    if (!waveCandidates || waveIdx >= waveCandidates.length) {
                        waveReady = false;
                        return;
                    }
                    waveVideo.src = waveCandidates[waveIdx++];
                    waveVideo.load();
                };

                waveVideo.addEventListener('canplay', () => {
                    waveReady = true;
                });
                waveVideo.addEventListener('error', () => {
                    tryNextWave();
                });

                const showIdle = () => {
                    if (idleVideo) idleVideo.style.display = 'block';
                    if (waveVideo) waveVideo.style.display = 'none';
                    if (idleVideo) {
                        idleVideo.play().catch(() => {
                            showThumb();
                        });
                    }
                };

                const playWaveOnce = () => {
                    if (!waveReady || wavePlaying) return;
                    wavePlaying = true;
                    if (idleVideo) idleVideo.style.display = 'none';
                    waveVideo.style.display = 'block';
                    waveVideo.currentTime = 0;
                    waveVideo.play().catch(() => {
                        wavePlaying = false;
                        showIdle();
                    });
                };

                waveVideo.addEventListener('ended', () => {
                    wavePlaying = false;
                    showIdle();
                });

                card.addEventListener('mouseenter', () => {
                    hovered = true;
                    if (hoverTimer) clearTimeout(hoverTimer);
                    hoverTimer = setTimeout(() => {
                        if (hovered) playWaveOnce();
                    }, 250);
                });

                card.addEventListener('mouseleave', () => {
                    hovered = false;
                    if (hoverTimer) {
                        clearTimeout(hoverTimer);
                        hoverTimer = null;
                    }
                    // Do not interrupt wave; it will finish then return to idle.
                });

                tryNextWave();
            }

            // WIRE EVENTS
            // 1. Info Toggle
            const toggleBtn = card.querySelector('.info-toggle-btn');
            const detailsPanel = card.querySelector('.details-panel');
            if (toggleBtn && detailsPanel) {
                toggleBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    detailsPanel.classList.toggle('hidden');
                    toggleBtn.classList.toggle('text-primary');
                    toggleBtn.classList.toggle('border-primary/30');
                    // Analytics
                    if (!detailsPanel.classList.contains('hidden')) {
                        if (typeof app.trackCoachEvent === 'function') {
                            app.trackCoachEvent('Reviewed Persona Info', { Persona: name || 'Unknown' });
                        }
                    }
                });
            }

            // 1.5 Audio Preview
            const audioBtn = card.querySelector('.audio-preview-btn');
            if (audioBtn) {
                audioBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // Analytics
                    if (typeof app.trackCoachEvent === 'function') {
                        app.trackCoachEvent('Reviewed Persona Voice', { Persona: name || 'Unknown' });
                    }
                    // Basic Preview Implementation (if supported)
                    if (typeof app.playVoicePreview === 'function') {
                        app.playVoicePreview(voice);
                    }
                });
            }

            // 2. Connect Action
            const connectBtn = card.querySelector('.connect-action-btn');
            if (connectBtn) {
                connectBtn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    if (typeof app.stopActivePreview === 'function') {
                        await app.stopActivePreview({ clearPreview: false });
                    }

                    console.log('[Erica] Selected coach:', name);
                    // Clear invalid coach flag so connect() doesn't abort
                    app._urlCoachInvalid = false;
                    // Mark as explicit user choice (not default fallback)
                    app._userExplicitlySelectedCoach = true;

                    try {
                        window.parent.postMessage(
                            { action: "onCoachSelect", coach: JSON.stringify({ 'name': name, 'image': thumbImg?.src }) },
                            "*"
                        );
                    } catch (_) {}


                    const prevVoice = app.selectedVoice || null;
                    const prevCompanionId = app.selectedCompanionId || null;

                    // Set Voice
                    if (typeof app.setSelectedVoice === 'function') {
                        // Provide thumb if available so header/avatar updates immediately
                        const chosenThumb = (thumbImg && thumbImg.style.display !== 'none') ? thumbImg.src : null;
                        app.setSelectedVoice(voice, chosenThumb, name, companionId);
                    }

                    // Close Overlay
                    const overlay = document.getElementById('voiceMenuOverlay');
                    if (overlay) overlay.style.display = 'none';

                    // Apply the coach selection to the OpenAI session.
                    // This mirrors the legacy behavior: voice/persona changes require a fresh Realtime session.
                    // - If we're already connected (or have an active datachannel), reconnect.
                    // - If we're mid-connect, just let the in-flight connection finish using the updated selection.
                    // - Otherwise, start a connection now.
                    const hasActiveDc = !!(app.dataChannel && app.dataChannel.readyState === 'open');
                    const isMidConnect = !!app.isConnecting && !app.isConnected;
                    const canReconnect = typeof app.reconnectWithNewVoice === 'function';
                    const canConnect = typeof app.connect === 'function';
                    const sameCoach =
                        (!!prevVoice && prevVoice === voice) &&
                        ((prevCompanionId || null) === (companionId || null));

                    if (isMidConnect) {
                        return;
                    }

                    if ((app.isConnected || hasActiveDc) && sameCoach) {
                        if (typeof app.setCallAudioEnabled === 'function') {
                            app.setCallAudioEnabled(!!app.isRecording);
                        }
                        if (typeof app.requestOpeningLine === 'function') {
                            app.requestOpeningLine();
                        }
                        return;
                    }

                    if (canReconnect && (app.isConnected || hasActiveDc)) {
                        if (typeof app.setCallAudioEnabled === 'function') {
                            app.setCallAudioEnabled(!!app.isRecording);
                        }
                        app.reconnectWithNewVoice();
                        return;
                    }

                    if (canConnect && !app.isConnected) {
                        if (typeof app.setCallAudioEnabled === 'function') {
                            app.setCallAudioEnabled(!!app.isRecording);
                        }
                        app.connect().catch(() => { });
                    }
                });
            }

            // 3. Audio Preview
            const previewBtn = card.querySelector('.audio-preview-btn');
            if (previewBtn) {
                previewBtn.setAttribute('data-companion-id', companionId || '');
                previewBtn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof app.playCoachPreview === 'function') {
                        // Show full description while preview plays (same behavior as info button)
                        if (detailsPanel && detailsPanel.classList.contains('hidden')) {
                            detailsPanel.classList.remove('hidden');
                        }
                        if (toggleBtn) {
                            toggleBtn.classList.add('text-teal-600');
                        }
                        const iconEl = previewBtn.querySelector('.preview-icon');
                        const spinEl = previewBtn.querySelector('.preview-spinner');
                        const targetId = companionId || null;
                        const activeId = app.currentPreviewCompanionId || null;
                        const isActivePreview = typeof app.isPreviewActive === 'function' ? app.isPreviewActive() : false;
                        const isSamePreview =
                            isActivePreview &&
                            targetId &&
                            activeId &&
                            String(targetId).toLowerCase() === String(activeId).toLowerCase();

                        const resetPreviewBtn = () => {
                            previewBtn.dataset.previewBusy = '';
                            previewBtn.classList.remove('opacity-70', 'text-green-500');
                            previewBtn.classList.add('text-gray-400');
                            if (iconEl) iconEl.classList.remove('hidden');
                            if (spinEl) spinEl.classList.add('hidden');
                        };

                        const setPreviewPlaying = () => {
                            // Reset any other preview buttons that are still green
                            document.querySelectorAll('.audio-preview-btn.text-teal-600').forEach(btn => {
                                if (btn !== previewBtn) {
                                    btn.classList.remove('text-teal-600');
                                    btn.classList.add('text-gray-400');
                                    const otherIcon = btn.querySelector('.preview-icon');
                                    const otherSpin = btn.querySelector('.preview-spinner');
                                    if (otherIcon) otherIcon.classList.remove('hidden');
                                    if (otherSpin) otherSpin.classList.add('hidden');
                                    btn.dataset.previewBusy = '';
                                }
                            });
                            previewBtn.dataset.previewBusy = '';
                            previewBtn.classList.remove('opacity-70', 'text-gray-400');
                            previewBtn.classList.add('text-teal-600');
                            if (spinEl) spinEl.classList.add('hidden');
                            if (iconEl) iconEl.classList.remove('hidden');
                            // Revert to normal when audio finishes naturally
                            if (app.previewTtsAudio) {
                                app.previewTtsAudio.onended = () => {
                                    app.previewTtsPlaying = false;
                                    resetPreviewBtn();
                                };
                            }
                        };

                        // Allow click-to-cancel even while preview is active
                        if (isSamePreview && typeof app.stopActivePreview === 'function') {
                            await app.stopActivePreview({ clearPreview: true });
                            resetPreviewBtn();
                            return;
                        }

                        if (previewBtn.dataset.previewBusy === '1' && !isActivePreview) {
                            return;
                        }

                        previewBtn.dataset.previewBusy = '1';
                        previewBtn.classList.add('opacity-70');
                        if (iconEl) iconEl.classList.add('hidden');
                        if (spinEl) spinEl.classList.remove('hidden');

                        const text = fullDesc || subtitleText || '';
                        try {
                            const previewPromise = app.playCoachPreview({
                                companionId,
                                openaiVoice: voice,
                                coachName: name,
                                text
                            });
                            const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 15000));
                            const result = await Promise.race([previewPromise, timeoutPromise]);
                            if (result === true) {
                                setPreviewPlaying();
                            } else {
                                resetPreviewBtn();
                            }
                        } catch (e) {
                            resetPreviewBtn();
                        }
                    }
                });
            }

            allCards.push({ card, companionId, name, role });
        });

        // --- Section-based rendering ---
        // If navigatorResult exists, group cards into: Primary / Autonomy / Browse all
        // Otherwise, render flat list (existing behavior)

        // Helper: make a card compact (smaller avatar, inline badge, hide info/audio row)
        const makeCompact = (cardObj) => {
            const el = cardObj.card;
            // Shrink avatar from 48px to 36px
            const avatarContainer = el.querySelector('.w-\\[48px\\].h-\\[48px\\]');
            if (avatarContainer) {
                avatarContainer.className = avatarContainer.className
                    .replace(/w-\[48px\]/g, 'w-[36px]')
                    .replace(/h-\[48px\]/g, 'h-[36px]');
            }
            const innerAvatar = el.querySelectorAll('.w-\\[48px\\].h-\\[48px\\]');
            innerAvatar.forEach(a => {
                a.className = a.className
                    .replace(/w-\[48px\]/g, 'w-[36px]')
                    .replace(/h-\[48px\]/g, 'h-[36px]');
            });

            // Move style badge inline with name
            const nameEl = el.querySelector('h3');
            const badgeEl = el.querySelector('.rounded-full.text-xs.font-medium');
            if (nameEl && badgeEl) {
                const nameRow = nameEl.parentElement;
                // Remove badge from its current location
                badgeEl.parentElement.removeChild(badgeEl);
                // Make badge smaller and add to name row
                badgeEl.classList.add('ml-1');
                badgeEl.style.fontSize = '10px';
                badgeEl.style.padding = '1px 6px';
                nameRow.appendChild(badgeEl);
            }

            // Reduce padding
            el.classList.remove('p-4');
            el.classList.add('p-3');
        };

        // Hide/show the default "Choose Your Coach" header based on navigator result
        const coachListHeader = document.getElementById('coachListHeader');

        if (navResult && navResult.primary) {
            if (coachListHeader) coachListHeader.style.display = 'none';
            const primaryId = String(navResult.primary).toLowerCase();
            const autonomyId = navResult.autonomy ? String(navResult.autonomy).toLowerCase() : null;

            const primaryCard = allCards.find(c =>
                String(c.companionId || '').toLowerCase() === primaryId ||
                String(c.role || '').toLowerCase() === primaryId
            );
            const autonomyCard = autonomyId ? allCards.find(c =>
                c !== primaryCard && (
                    String(c.companionId || '').toLowerCase() === autonomyId ||
                    String(c.role || '').toLowerCase() === autonomyId
                )
            ) : null;
            const restCards = allCards.filter(c => c !== primaryCard && c !== autonomyCard);

            // --- "Your match" header + explanation ---
            const matchSection = document.createElement('div');
            matchSection.className = 'text-center mb-4';
            const primaryName = primaryCard ? primaryCard.name : navResult.primary;
            const primaryStyle = primaryCard ? primaryCard.role : navResult.primary;
            matchSection.innerHTML = `
                <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-teal-50 text-primary text-xs font-semibold mb-2">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg>
                    Your match
                </span>
                <h2 class="text-2xl font-bold text-gray-900 mt-2">We Found Your AI Coach</h2>
                <h3 class="text-lg font-semibold text-gray-700 mt-1">Meet ${primaryName}</h3>
                <p class="text-sm text-gray-500 mt-1 px-4">Based on your answers, we recommend ${primaryName} because their ${primaryStyle} coaching style fits what you need right now.</p>
            `;
            listContainer.appendChild(matchSection);

            if (primaryCard) {
                // Add "Recommended" badge
                const nameEl = primaryCard.card.querySelector('h3');
                if (nameEl && !nameEl.parentElement.querySelector('.recommended-badge')) {
                    const badge = document.createElement('span');
                    badge.className = 'recommended-badge text-[10px] text-green-600 font-medium whitespace-nowrap';
                    badge.textContent = '● Recommended';
                    nameEl.parentElement.appendChild(badge);
                }
                // Highlight border
                primaryCard.card.classList.add('border-primary', 'border-2');
                primaryCard.card.classList.remove('border-borderColor');
                // Make Connect button filled teal (only for "Connect", not "Resume")
                const connectBtn = primaryCard.card.querySelector('.connect-action-btn');
                const isResume = connectBtn && connectBtn.textContent.trim().startsWith('Resume');
                if (connectBtn && !isResume) {
                    connectBtn.className = connectBtn.className
                        .replace('border-gray-300', 'border-primary')
                        .replace('text-gray-700', 'text-white')
                        .replace('bg-white', 'bg-primary')
                        .replace('hover:bg-gray-50', 'hover:bg-teal-600');
                } else if (connectBtn && isResume) {
                    // Ensure Resume button keeps dark text (never white)
                    connectBtn.classList.remove('text-white');
                    connectBtn.classList.add('text-gray-700');
                }
                listContainer.appendChild(primaryCard.card);
            }

            // --- "Also a great fit" section (compact) ---
            if (autonomyCard) {
                const alsoHeader = document.createElement('div');
                alsoHeader.className = 'text-xs text-gray-500 font-medium mt-5 mb-2';
                alsoHeader.textContent = 'Other Great Fits';
                listContainer.appendChild(alsoHeader);
                makeCompact(autonomyCard);
                listContainer.appendChild(autonomyCard.card);
            }

            // --- "Browse all coaches" section (compact) ---
            if (restCards.length > 0) {
                const browseHeader = document.createElement('div');
                browseHeader.className = 'flex items-center justify-between mt-5 mb-2';
                browseHeader.innerHTML = `
                    <span class="text-xs text-gray-500 font-medium">Explore All AI Coaches</span>
                    <button class="retake-quiz-btn text-xs text-primary font-medium hover:underline cursor-pointer" type="button">Retake quiz</button>
                `;
                listContainer.appendChild(browseHeader);

                // Wire retake quiz button — clears saved result and relaunches navigator
                const retakeBtn = browseHeader.querySelector('.retake-quiz-btn');
                if (retakeBtn) {
                    retakeBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        console.log('[Erica] Retake quiz clicked');
                        // Clear saved navigator result
                        if (typeof EricaNavigator !== 'undefined') {
                            EricaNavigator.clearSavedResult();
                        }
                        app._lastNavigatorResult = null;
                        app.navigatorTags = null;
                        // Relaunch navigator
                        if (typeof app._showNavigator === 'function' && Array.isArray(app.lastCompanions)) {
                            listContainer.innerHTML = '';
                            app._showNavigator(app.lastCompanions);
                        }
                    });
                }

                restCards.forEach(c => {
                    makeCompact(c);
                    listContainer.appendChild(c.card);
                });
            }
        } else {
            // No navigator result — flat list (existing behavior)
            if (coachListHeader) coachListHeader.style.display = '';
            allCards.forEach(c => listContainer.appendChild(c.card));
        }
    }


    function setVoiceMenuOpen(app, open) {
        const overlay = document.getElementById('voiceMenuOverlay');
        const menu = document.getElementById('voiceMenu');

        if (overlay) {
            overlay.style.display = open ? 'flex' : 'none';
        }

        if (open && typeof messageToApp === 'function') {
            messageToApp({ action: 'ericaListingPage' });
        }
    }

    function setWaitingState(app, isWaiting) {
        const loader = document.getElementById('chatLoader');
        const micBtn = document.getElementById('micToggleBtn');
        const chatContainer = document.getElementById('chatMessages');
        const scrollContainer = document.getElementById('chatContainer');

        if (loader) {
            if (isWaiting) {
                loader.classList.remove('hidden');
                // Ensure it's at the bottom
                if (chatContainer) {
                    chatContainer.appendChild(loader);
                }
                // Scroll to bottom
                if (scrollContainer) {
                    scrollContainer.scrollTo({
                        top: scrollContainer.scrollHeight,
                        behavior: 'smooth'
                    });
                }
            } else {
                loader.classList.add('hidden');
            }
        }

        if (micBtn) {
            // Only manipulate if we found the button
            if (isWaiting) {
                micBtn.disabled = true;
                micBtn.classList.add('opacity-50', 'cursor-not-allowed', 'pointer-events-none');
            } else {
                micBtn.disabled = false;
                micBtn.classList.remove('opacity-50', 'cursor-not-allowed', 'pointer-events-none');
            }
        }
    }

    // Export helpers
    global.uiLayout = {
        initLayout,
        updateTextButtonVisibility,
        updateMicToggleVisibility,
        setMicToggleUI,
        updateStatusDot,
        updateMessageElement,
        setVoiceMenuOpen,
        updateSpeakerLevel,
        updateMicLevel,
        updateMicLevel,
        playCallModeWave,
        updateCallPanelMicUI, // Exported for app.js sync
        setWaitingState, // Exported
        setSpeedPillSelection: () => { },
        setSpeakButtonState: () => { },
        setCallAudioIcon: () => { },
        updateAudioStatus: () => { },
        setCallModePanelOpen, // Exported now
        renderCoachList, // Expose as: uiLayout.renderCoachList(app, companions)
    };

    global.initLayout = initLayout;
})(typeof window !== 'undefined' ? window : this);
