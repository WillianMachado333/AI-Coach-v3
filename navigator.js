/**
 * AI Coach Navigator
 *
 * A 3-question intake flow that routes users to the most appropriate coaching style.
 * Built as a standard HTML form with fieldsets — each question is a step.
 *
 * Usage:
 *   const nav = new EricaNavigator(containerElement, {
 *       onComplete: (result) => { ... },
 *       onSkip: () => { ... },
 *       trackEvent: (name, props) => { ... }
 *   });
 *   await nav.load();
 *   nav.show();
 */
(function (global) {

    const STORAGE_KEY = 'navigatorResult';
    const DATA_URL = 'navigatorData.json';

    class EricaNavigator {

        constructor(parent, options = {}) {
            this.parent = parent;               // DOM element to render into
            this.onComplete = options.onComplete || (() => {});
            this.onSkip = options.onSkip || (() => {});
            this.trackEvent = options.trackEvent || (() => {});
            this.data = null;                   // loaded from JSON
            this.currentStep = -1;              // -1 = welcome, 0+ = question index
            this.container = null;              // our root DOM element
            this.form = null;                   // the <form> element
        }

        // --- Load question data ---
        async load(url) {
            try {
                const res = await fetch(url || DATA_URL);
                this.data = await res.json();
            } catch (err) {
                console.error('[Navigator] Failed to load data:', err);
                this.data = null;
            }
            return this;
        }

        // --- Show the navigator (creates DOM) ---
        show() {
            if (!this.data || !this.data.questions) {
                console.warn('[Navigator] No data loaded, skipping');
                this.onSkip();
                return;
            }

            // Create container
            this.container = document.createElement('div');
            this.container.id = 'navigatorContainer';

            // Build the form with all fieldsets
            this.container.innerHTML = this._buildHTML();
            this.parent.prepend(this.container);

            // Cache form reference
            this.form = this.container.querySelector('#navigatorForm');

            // Wire events
            this._wireEvents();

            // Show welcome
            this.currentStep = -1;
            this._showStep(-1);

            this.trackEvent('Navigator Started', {});
        }

        // --- Remove navigator from DOM ---
        destroy() {
            if (this.container) {
                this.container.remove();
                this.container = null;
                this.form = null;
            }
        }

        // --- Build all HTML upfront ---
        _buildHTML() {
            const d = this.data;
            const totalQuestions = d.questions.length;

            // Welcome screen
            let html = `<form id="navigatorForm" class="navigator-form">`;

            // Welcome fieldset
            html += `
                <fieldset data-step="-1" class="nav-step">
                    <div class="text-center py-4 px-2 max-w-md mx-auto">
                        <div class="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-teal-50 mb-4">
                            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-primary">
                                <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/>
                            </svg>
                        </div>
                        <h2 class="text-2xl font-bold text-gray-900 mb-2">${this._esc(d.welcome.title)}</h2>
                        <p class="text-sm text-gray-500 mb-5 px-4">${this._esc(d.welcome.subtitle)}</p>
                        <div class="text-left max-w-xs mx-auto mb-6">
                            ${(d.welcome.bullets || []).map(b => `
                                <div class="flex items-start gap-2 mb-2">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="text-primary flex-shrink-0 mt-0.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
                                    <span class="text-sm text-gray-600">${this._esc(b)}</span>
                                </div>
                            `).join('')}
                        </div>
                        <button type="button" class="nav-start-btn w-full max-w-xs py-3 rounded-xl bg-directiveColor text-white font-semibold text-sm hover:opacity-90 transition-colors">
                            ${this._esc(d.welcome.startButton || 'Start')}
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="inline ml-1"><polyline points="9 18 15 12 9 6"></polyline></svg>
                        </button>
                    </div>
                </fieldset>
            `;

            // Question fieldsets
            d.questions.forEach((q, idx) => {
                html += `
                    <fieldset data-step="${idx}" class="nav-step hidden max-w-md mx-auto px-4 pt-8 pb-8">
                        <!-- Header: Back + Close -->
                        <div class="flex items-center justify-between mb-3">
                            <button type="button" class="nav-back-btn text-sm text-gray-500 hover:text-gray-700 font-medium">
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="inline mr-0.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
                                Back
                            </button>
                            <button type="button" class="nav-close-btn text-gray-400 hover:text-gray-600 p-1">
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                            </button>
                        </div>

                        <!-- Progress bar + label (separate line) -->
                        <div class="flex items-center gap-2 mb-5">
                            ${d.questions.map((_, i) => `<div class="w-8 h-1.5 rounded-full transition-colors ${i <= idx ? 'bg-primary' : 'bg-gray-200'}"></div>`).join('')}
                            <span class="text-xs text-gray-400 ml-1">Question ${idx + 1} of ${totalQuestions}</span>
                        </div>

                        <!-- Label + Title -->
                        <div class="text-primary text-xs font-bold tracking-wide mb-1">${this._esc(q.label)}</div>
                        <h3 class="text-xl font-bold text-gray-900 mb-5 leading-snug">${this._esc(q.title)}</h3>

                        <!-- Options -->
                        <div class="flex flex-col gap-3">
                            ${this._buildOptions(q, idx)}
                        </div>
                    </fieldset>
                `;
            });

            html += `</form>`;
            return html;
        }

        // --- Build options for a question based on type ---
        _buildOptions(question, stepIndex) {
            if (question.type === 'radio' || !question.type) {
                return (question.options || []).map((opt, oi) => `
                    <label class="nav-option group cursor-pointer">
                        <input type="radio" name="${question.id}" value="${this._esc(opt.value)}"
                               data-step="${stepIndex}" class="sr-only">
                        <div class="nav-option-card flex items-center justify-between w-full p-4 rounded-xl border-2 border-gray-200 transition-all group-hover:border-primary/50">
                            <span class="text-sm text-gray-800">${this._esc(opt.text)}</span>
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-gray-400 group-hover:text-primary flex-shrink-0 ml-2"><polyline points="9 18 15 12 9 6"></polyline></svg>
                        </div>
                    </label>
                `).join('');
            }

            if (question.type === 'text') {
                return `
                    <textarea name="${question.id}" rows="3" placeholder="${this._esc(question.placeholder || 'Tell us more...')}"
                              class="w-full p-3 rounded-xl border-2 border-gray-200 focus:border-primary focus:outline-none text-sm resize-none"></textarea>
                    <button type="button" class="nav-next-btn w-full py-3 rounded-xl bg-primary text-white font-semibold text-sm hover:bg-teal-600 transition-colors mt-2" data-step="${stepIndex}">
                        Continue
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="inline ml-1"><polyline points="9 18 15 12 9 6"></polyline></svg>
                    </button>
                `;
            }

            // Fallback for unknown types
            return `<p class="text-sm text-gray-500">Unsupported question type: ${question.type}</p>`;
        }

        // --- Wire all events ---
        _wireEvents() {
            const container = this.container;

            // Start button
            const startBtn = container.querySelector('.nav-start-btn');
            if (startBtn) {
                startBtn.addEventListener('click', () => {
                    this._showStep(0);
                });
            }

            // Radio auto-advance: when an option is selected, brief highlight then advance
            this.form.addEventListener('change', (e) => {
                if (e.target.type === 'radio') {
                    const stepIdx = parseInt(e.target.dataset.step, 10);
                    const question = this.data.questions[stepIdx];

                    // Highlight selected card
                    const fieldset = e.target.closest('fieldset');
                    fieldset.querySelectorAll('.nav-option-card').forEach(c => {
                        c.classList.remove('border-primary', 'bg-teal-50');
                        c.classList.add('border-gray-200');
                    });
                    const selectedCard = e.target.closest('label').querySelector('.nav-option-card');
                    selectedCard.classList.remove('border-gray-200');
                    selectedCard.classList.add('border-primary', 'bg-teal-50');

                    // Track
                    this.trackEvent('Navigator Question Answered', {
                        questionNumber: stepIdx + 1,
                        questionId: question.id,
                        tag: e.target.value
                    });

                    // Advance after a brief delay (let user see their selection)
                    setTimeout(() => {
                        if (stepIdx < this.data.questions.length - 1) {
                            this._showStep(stepIdx + 1);
                        } else {
                            this._complete();
                        }
                    }, 350);
                }
            });

            // "Continue" buttons for non-radio questions (text, etc.)
            container.querySelectorAll('.nav-next-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const stepIdx = parseInt(btn.dataset.step, 10);
                    const question = this.data.questions[stepIdx];

                    this.trackEvent('Navigator Question Answered', {
                        questionNumber: stepIdx + 1,
                        questionId: question.id,
                        tag: this.form.elements[question.id]?.value || ''
                    });

                    if (stepIdx < this.data.questions.length - 1) {
                        this._showStep(stepIdx + 1);
                    } else {
                        this._complete();
                    }
                });
            });

            // Back buttons
            container.querySelectorAll('.nav-back-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    this._showStep(this.currentStep - 1);
                });
            });

            // Close buttons
            container.querySelectorAll('.nav-close-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    this.trackEvent('Navigator Skipped', {
                        lastStep: this.currentStep
                    });
                    this.destroy();
                    this.onSkip();
                });
            });
        }

        // --- Show/hide fieldsets ---
        _showStep(index) {
            this.currentStep = index;
            this.container.querySelectorAll('.nav-step').forEach(fs => {
                const step = parseInt(fs.dataset.step, 10);
                if (step === index) {
                    fs.classList.remove('hidden');
                } else {
                    fs.classList.add('hidden');
                }
            });

            // Scroll to top of container
            if (this.parent.scrollTop !== undefined) {
                this.parent.scrollTop = 0;
            }
        }

        // --- Compute scores and complete ---
        _complete() {
            const result = this._computeResult();

            this.trackEvent('Navigator Completed', {
                mood: result.tags.mood || null,
                readiness: result.tags.readiness || null,
                clarity: result.tags.clarity || null,
                primaryCoach: result.primary,
                autonomyCoach: result.autonomy
            });

            // Save to localStorage
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify({
                    ...result,
                    timestamp: Date.now()
                }));
            } catch (_) {}

            this.destroy();
            this.onComplete(result);
        }

        // --- Compute result: flat lookup table first, weighted scoring as fallback ---
        _computeResult() {
            const tags = {};

            this.data.questions.forEach(q => {
                const value = this.form?.elements[q.id]?.value;
                if (value) tags[q.id] = value;
            });

            // Try flat lookup table first (guaranteed correct for known combinations)
            if (this.data.routes) {
                const key = [tags.mood, tags.readiness, tags.clarity].filter(Boolean).join('|');
                const route = this.data.routes[key];
                if (route && route.length >= 2) {
                    console.log('[Navigator] Route table match:', key, '→', route[0], '/', route[1]);
                    return {
                        primary: route[0],
                        autonomy: route[1],
                        scores: {},
                        tags
                    };
                }
            }

            // Fallback: weighted scoring (for new questions/options not in the table)
            console.log('[Navigator] No route table match, using weighted scoring');
            const scores = {};

            this.data.questions.forEach(q => {
                const value = tags[q.id];
                if (!value || !q.options) return;

                const selected = q.options.find(o => o.value === value);
                if (selected && selected.weights) {
                    Object.entries(selected.weights).forEach(([style, weight]) => {
                        scores[style] = (scores[style] || 0) + weight;
                    });
                }
            });

            const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);

            return {
                primary: ranked[0]?.[0] || null,
                autonomy: ranked[1]?.[0] || null,
                scores,
                tags
            };
        }

        // --- Simple HTML escaping ---
        _esc(s) {
            if (!s) return '';
            return String(s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        // --- Static: check if navigator result exists in localStorage ---
        static getSavedResult() {
            try {
                const raw = localStorage.getItem(STORAGE_KEY);
                if (!raw) return null;
                return JSON.parse(raw);
            } catch (_) {
                return null;
            }
        }

        // --- Static: clear saved result (for retake quiz) ---
        static clearSavedResult() {
            try {
                localStorage.removeItem(STORAGE_KEY);
            } catch (_) {}
        }
    }

    // Expose globally
    global.EricaNavigator = EricaNavigator;

})(typeof window !== 'undefined' ? window : this);
