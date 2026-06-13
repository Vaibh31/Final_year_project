function safeGet(id, silent = false) {
  const el = document.getElementById(id);
  if (!el && silent !== true) {
    // Only warn if the app is already initialized to avoid noise during partial loads
    if (typeof appInitialized !== 'undefined' && appInitialized) {
      console.warn(`[DOM] Missing element: ${id}`);
    }
  }
  return el;
}

// Global alias for safeGet to maintain compatibility but with safety
const $ = safeGet;

/**
 * Safely parses a JSON string with a fallback value.
 */
function safeParseJSON(str, fallback = null) {
  if (!str) return fallback;
  if (typeof str === 'object') return str;
  try {
    return JSON.parse(str);
  } catch (e) {
    console.error("[JSON Fix] Parse failed:", e);
    return fallback;
  }
}

/**
 * Safely saves to localStorage to prevent QuotaExceededError crashes.
 */
function safeSetStorage(key, value) {
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  } catch (e) {
    console.warn("[Storage Fix] Save failed (quota?):", e);
  }
}


// ================= SAFE ANSWER STORE (FIXES "NOT ANSWERED" BUG) =================
window.currentQuizAnswers = window.currentQuizAnswers || {};
window.submittedQuizAnswers = null;

// Generation & Render Guard
let isManualGeneration = false;
window.blockAutoRender = false;
window.isGenerating = false;

// ================= QUESTION COUNT LIMITS =================
const MAX_QUIZ_QUESTIONS = 50;
const QUESTION_LIMIT_ERROR_MSG = "Only 50 questions can be generated at a time. If you need additional questions, please click the 'Generate More' button to continue generating questions or click the 'New Quiz' button to create a new quiz.";
window.isFileUploaded = false;
window.quizLifecycle = {
  state: "idle" // "idle" | "generated" | "submitted"
};

// ================= ACTIVE QUIZ CONTEXT (PREVENTS DATA LEAKAGE) =================
window.activeQuizContext = {
  get quizId() { return sessionStorage.getItem('brainify_active_quiz_id'); },
  set quizId(val) { if (val) sessionStorage.setItem('brainify_active_quiz_id', val); else sessionStorage.removeItem('brainify_active_quiz_id'); },
  get mode() { return sessionStorage.getItem('brainify_active_quiz_mode'); },
  set mode(val) { if (val) sessionStorage.setItem('brainify_active_quiz_mode', val); else sessionStorage.removeItem('brainify_active_quiz_mode'); }
};

window.isRenderingQuiz = false;

// 🔥 FIX START — OBJECTIVE 1 & 2: Central Full User Reset
// Tracks the current user ID to detect user switches
window._currentSessionUserId = null;

/**
 * fullUserReset() — Called on every auth event (login, signup, logout, onAuthStateChange).
 * Wipes ALL quiz-related state so no previous user's data leaks into the new session.
 */
function fullUserReset() {
  console.log("[Auth] fullUserReset() triggered — clearing all quiz state");

  // 1. Reset all global quiz flags
  window.currentQuizAnswers = {};
  window.submittedQuizAnswers = null;
  window.isGenerating = false;
  window.blockAutoRender = false;
  window.isRenderingQuiz = false;

  // 2. Reset lifecycle and context
  window.quizLifecycle = { state: "idle" };
  window.activeQuizContext.quizId = null;
  window.activeQuizContext.mode = null;
  window.quizUIState = { mode: "idle" };

  // 3. Clear quiz DOM containers
  [
    "#quiz-container", "#pdf-quiz-container",
    "#quiz-result", "#pdf-quiz-result"
  ].forEach(selector => {
    document.querySelectorAll(selector).forEach(el => {
      el.innerHTML = "";
      el.style.display = selector.includes("result") ? "none" : "";
    });
  });

  // 4. Clear quiz-related localStorage keys only (prefix: quiz_)
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith("quiz_"))
      .forEach(k => localStorage.removeItem(k));
    localStorage.removeItem("quiz_ui_mode");
  } catch (e) { /* storage may be unavailable */ }

  // 5. Reset Store quiz fields (preserve user/chats)
  if (typeof Store !== 'undefined') {
    Store.set({
      currentQuiz: [],
      currentQuizId: null,
      currentAttemptId: null,
      userAnswers: {},
      isQuizReview: false,
      quizStartTime: null,
      currentQuestionIndex: 0
    });
  }

  // 6. Sync button states
  applyButtonState();
  if (typeof applyButtonState === 'function') applyButtonState();

  console.log("[Auth] fullUserReset() complete");
}
window.fullUserReset = fullUserReset;
// 🔥 FIX END

// 🔥 FIX START — OBJECTIVE 5: Remove blocking guard that prevents proper reset
function resetEntireQuizEnvironment() {
  try {
    if (window.isRenderingQuiz) {
      console.warn("[Context] Reset blocked: Render in progress");
      return;
    }

    // 1. Clear ONLY top-level quiz containers and result panels
    const containers = [
      "#quiz-container", "#pdf-quiz-container",
      "#quiz-result", "#pdf-quiz-result"
    ];

    containers.forEach(selector => {
      document.querySelectorAll(selector).forEach(el => {
        el.innerHTML = "";
        el.style.display = selector.includes("result") ? "none" : "";
      });
    });

    // 2. Reset answer and context state
    window.currentQuizAnswers = {};
    window.submittedQuizAnswers = null;
    window.activeQuizContext.quizId = null;
    window.activeQuizContext.mode = null;
    window.blockAutoRender = false;
    if (typeof Store !== 'undefined') Store.set({ userAnswers: {} });

    // 3. Clear file preview
    const preview = $("uploaded-file-preview", true);
    if (preview) preview.innerHTML = "";

    console.log("[Context] Quiz environment fully reset");

    // 🔥 Sync lifecycle state on reset
    window.quizLifecycle.state = "idle";

    applyButtonState();
  } catch (err) {
    console.error("Reset error:", err);
  }
}
// 🔥 FIX END

function applyButtonState() {
  try {
    const generateBtn = document.getElementById("generateQuizBtn");
    const pdfGenBtn = document.getElementById("start-pdf-quiz-btn");
    const randomBtn = document.getElementById("randomTopicBtn");
    const submitBtn = document.getElementById("submit-quiz-btn");
    const pdfSubmitBtn = document.getElementById("pdf-submit-quiz-btn");
    const clearBtn = document.querySelector(".clear-responses-btn");


    // Collect all 'New Quiz' buttons
    const newQuizBtns = [
      document.getElementById("generate-new-quiz-btn"),
      document.getElementById("pdf-generate-new-quiz-btn"),
      document.getElementById("upload-new-quiz-btn")
    ].filter(Boolean);

    const enable = (btn) => {
      if (!btn) return;
      btn.disabled = false;
      btn.style.pointerEvents = "auto";
      btn.style.opacity = "1";
    };

    const disable = (btn) => {
      if (!btn) return;
      btn.disabled = true;
      btn.style.pointerEvents = "none";
      btn.style.opacity = "0.5";
    };

    if (!window.quizLifecycle) window.quizLifecycle = { state: "idle" };

    switch (window.quizLifecycle.state) {

      case "idle":
        enable(generateBtn);
        enable(pdfGenBtn);
        enable(randomBtn);
        disable(submitBtn);
        disable(pdfSubmitBtn);
        disable(clearBtn);
        newQuizBtns.forEach(disable);
        break;

      case "generated":
        disable(generateBtn);
        disable(pdfGenBtn);
        disable(randomBtn);
        enable(submitBtn);
        enable(pdfSubmitBtn);
        enable(clearBtn);
        newQuizBtns.forEach(enable);
        break;

      case "submitted":
        disable(generateBtn);
        disable(pdfGenBtn);
        disable(randomBtn);
        disable(submitBtn);
        disable(pdfSubmitBtn);
        disable(clearBtn);
        newQuizBtns.forEach(enable);
        break;

      default:
        console.error("Invalid state:", window.quizLifecycle.state);
    }

  } catch (err) {
    console.error("applyButtonState error:", err);
  }
}

// ================= STATE TRANSITIONS (MANDATORY) =================
async function handleGenerateQuiz() {
  if (window.quizLifecycle.state !== "idle") return;
  await startQuiz();
  // State is set inside startQuiz for success cases, but wrappers ensure consistency
}

async function handleGenerateQuizFromFile() {
  if (window.quizLifecycle.state !== "idle") return;
  await generateQuizFromFile();
}

function handleSubmitQuiz() {
  if (window.quizLifecycle.state !== "generated") return;
  submitQuiz();
}

function handleNewQuiz() {
  resetEntireQuizEnvironment();
  if (typeof removeSelectedFile === 'function') {
    removeSelectedFile();
  }
}

// Global listener for standard inputs (radio/checkbox)
document.addEventListener("change", function (e) {
  const input = e.target;
  if (input.type === "radio" || input.type === "checkbox") {
    // Attempt to find question ID from container or data attribute
    const questionEl = input.closest("[data-question-id]") || input.closest(".quiz-question-block");
    if (!questionEl) return;

    const qid = questionEl.dataset.questionId || questionEl.dataset.qi;
    if (qid !== undefined) {
      window.currentQuizAnswers[qid] = input.value;
      console.log("[Quiz] Saved Answer via Change:", qid, input.value);
    }
  }
});

// ================= AUTO-REINJECTING CLEAR BUTTON (STRONG VERSION) =================
function ensureClearButton() {
  if (window.quizLifecycle.state === "submitted") return; // Fix: Lifecycle guard
  try {
    const submitBtns = [
      document.getElementById("submit-quiz-btn"),
      document.getElementById("pdf-submit-quiz-btn")
    ];

    submitBtns.forEach(submitBtn => {
      // Only inject if submit button is visible (quiz is active)
      if (!submitBtn || submitBtn.style.display === "none") return;

      const parent = submitBtn.parentElement;
      if (!parent) return;

      // Prevent duplicates
      if (parent.querySelector(".clear-responses-btn")) return;

      const btn = document.createElement("button");
      btn.innerHTML = "🧹 Clear Responses";
      btn.className = "clear-responses-btn generate-btn";

      // Override specific layout styles to fit beside submit
      btn.style.marginLeft = "12px";
      btn.style.marginTop = "24px"; // Match submit button margin
      btn.style.minWidth = "auto";
      btn.style.padding = "14px 24px";

      parent.appendChild(btn);
      console.log("[UI] Clear button injected beside", submitBtn.id);
      applyButtonState();
    });
  } catch (err) {
    console.error("Button injection error:", err);
  }
}

// Global listener for Clear button
document.addEventListener("click", function (e) {
  const btn = e.target.closest(".clear-responses-btn");
  if (!btn) return;

  if (window.quizLifecycle.state === "submitted") return; // Fix: Prevent execution after submission

  try {
    if (!confirm("Do you want to clear all responses?")) return;

    // 1. Clear UI
    document.querySelectorAll(".quiz-option").forEach(el => el.classList.remove("selected"));
    document.querySelectorAll("input").forEach(input => { input.checked = false; });

    // 2. Clear Internal State
    window.currentQuizAnswers = {};
    Store.set({ userAnswers: {} });

    // 3. Clear localStorage
    const quizId = Store.state.currentQuizId;
    if (quizId && AuthManager.user) {
      const storageKey = `quiz_draft_${AuthManager.user.id}_${quizId}`;
      localStorage.removeItem(storageKey);
    }

    console.log("[Quiz] All responses cleared");
    applyButtonState();
  } catch (err) {
    console.error("Clear button error:", err);
  }
});

// Disable Clear button after submit
document.addEventListener("click", function (e) {
  const submitBtn = e.target.closest("#submit-quiz-btn") || e.target.closest("#pdf-submit-quiz-btn");
  if (!submitBtn) return;

  try {
    // Small delay to ensure we catch the button if it's being re-rendered
    setTimeout(() => {
      const clearBtn = document.querySelector(".clear-responses-btn");
      if (clearBtn) {
        clearBtn.disabled = true;
        clearBtn.style.opacity = "0.5";
        clearBtn.style.pointerEvents = "none";
      }
    }, 100);
  } catch (err) {
    console.error("Disable clear button error:", err);
  }
});

// 🔥 FIX START — OBJECTIVE 8: Prevent duplicate Clear button injection
// Use a debounced observer that checks existence before injecting
let _clearBtnObserverTimeout = null;
const clearBtnObserver = new MutationObserver(() => {
  // Debounce to avoid firing on every single DOM mutation
  clearTimeout(_clearBtnObserverTimeout);
  _clearBtnObserverTimeout = setTimeout(() => {
    // Only inject if lifecycle is in 'generated' state (quiz is active)
    if (window.quizLifecycle?.state === 'generated') {
      ensureClearButton();
    }
  }, 150);
});
clearBtnObserver.observe(document.body, { childList: true, subtree: true });
// 🔥 FIX END

// Initial Load
window.addEventListener('load', () => {
  setTimeout(ensureClearButton, 500);

  // Prevent stale state from previous sessions
  if (!window.quizUIState || !window.quizUIState.mode) {
    window.quizUIState = { mode: "idle" };
  }
  if (!window.quizLifecycle || !window.quizLifecycle.state) {
    window.quizLifecycle = { state: "idle" };
  }

  // Always sync buttons on load
  applyButtonState();
});

// ================= ROBUST QUIZ UI STATE CONTROL =================
window.quizUIState = window.quizUIState || {
  mode: "idle"
};


// Event Delegation for Dynamic Buttons
document.addEventListener('click', function (e) {
  const target = e.target.closest('button');
  if (!target) return;

  // 🔥 FIX START — DETECT "+ Generate More" CLICK RELIABLY (NO TEXT MATCHING)
  const isGenerateMoreBtn = target.closest('[data-action="generate-more"], .more-btn');
  if (isGenerateMoreBtn) {
    // ✅ CRITICAL: Switch mode from VIEW → ACTIVE
    window.activeQuizContext.mode = "new";

    // window.quizLifecycle.state = "generated"; // Already in generated state
    applyButtonState();
    console.log("[FIX] Generate More → switched to ACTIVE mode");
  }
  // 🔥 FIX END

  const id = target.id;
  const text = (target.innerText || "").toLowerCase();

  // 🔥 Requirement 6: Use ID-based detection ONLY for generation
  if (id === 'generateQuizBtn' || id === 'start-pdf-quiz-btn') {
    isManualGeneration = true;
  }

  try {
    if (text.includes('resume')) {
      window.activeQuizContext.mode = "resume";
      applyButtonState();
    }
    else if (text.includes('view')) {
      window.activeQuizContext.mode = "view";
      applyButtonState();
    }
    else if (text.includes('new quiz')) {
      window.activeQuizContext.mode = "new";
      applyButtonState();
    }
    else if (id === 'generateQuizBtn' || id === 'start-pdf-quiz-btn') {
      window.activeQuizContext.mode = "idle";
      applyButtonState();
    }
  } catch (err) {
    console.error("Event handling error:", err);
  }

  // ── VIEW / RESUME DELEGATION ──
  const viewBtn = target.closest(".view-btn") || target.closest(".resume-btn") || target.closest(".sidebar-history-item");
  if (viewBtn) {
    const attemptId = viewBtn.dataset.attemptId;
    if (attemptId) {
      console.log("[Delegation] View/Resume clicked for attempt:", attemptId);

      // Fix Requirement 1: Set activeQuizContext
      window.activeQuizContext.quizId = attemptId;
      window.activeQuizContext.mode = target.closest(".resume-btn") ? "resume" : "view";

      window.blockAutoRender = true; // 🔥 CRITICAL LOCK: Block AI auto-renders
      loadAttempt(attemptId);
      return;
    }
  }

  // ── RETAKE DELEGATION ──
  const retakeBtn = target.closest(".retake-btn");
  if (retakeBtn) {
    const quizId = retakeBtn.dataset.quizId;
    if (quizId) {
      console.log("[Delegation] Retake clicked for quiz:", quizId);

      retakeQuiz(quizId);
      return;
    }
  }

  // ── GENERATE MORE DELEGATION ──
  const moreBtn = target.closest('[data-action="generate-more"]');
  if (moreBtn) {
    const quizId = moreBtn.dataset.quizId || moreBtn.closest("[data-quiz-id]")?.dataset.quizId;
    if (quizId) {
      console.log("[Delegation] Generate More clicked for quiz:", quizId);

      generateMoreFromQuiz(quizId);
      return;
    }
  }

  // ── DELETE DELEGATION ──
  const deleteBtn = target.closest(".delete-btn");
  if (deleteBtn) {
    const quizId = deleteBtn.dataset.quizId;
    const attemptId = deleteBtn.dataset.attemptId;
    if (quizId && attemptId) {
      console.log("[Delegation] Delete clicked for attempt:", attemptId);
      deleteAttempt(quizId, attemptId);
      return;
    }
  }
});

// MutationObserver to handle dynamic UI updates
const quizUiObserver = new MutationObserver(() => {
  applyButtonState();
});
quizUiObserver.observe(document.body, {
  childList: true,
  subtree: true
});

// Initial Load Fix
window.addEventListener('load', () => {
  setTimeout(() => {
    applyButtonState();
  }, 500);
});

// Global Store
const Store = {
  state: {
    user: null,
    quizzes: [],      // History of attempts + quiz metadata
    chats: [],        // History of chat sessions
    activeChatId: null,
    currentQuiz: null, // Active quiz being taken
    currentQuizId: null,
    currentAttemptId: null,
    userAnswers: {},
    isQuizReview: false,
    quizStartTime: null,
    currentQuestionIndex: 0,
    isFetchingTopic: false,
    lastRandomTopic: ""
  },

  listeners: [],

  set(partial) {
    this.state = { ...this.state, ...partial };
    this.notify();
  },

  get() {
    return this.state;
  },

  subscribe(fn) {
    this.listeners.push(fn);
    // Call immediately with current state
    fn(this.state);
  },

  notify() {
    this.listeners.forEach(fn => {
      try {
        fn(this.state);
      } catch (e) {
        console.error("[Store] Listener Error:", e);
      }
    });
  },

  reset() {
    this.state = {
      user: null,
      quizzes: [],      // History of attempts + quiz metadata
      chats: [],        // History of chat sessions
      activeChatId: null,
      currentQuiz: null, // Active quiz being taken
      currentQuizId: null,
      currentAttemptId: null,
      userAnswers: {},
      isQuizReview: false,
      quizStartTime: null,
      currentQuestionIndex: 0,
      isFetchingTopic: false,
      lastRandomTopic: ""
    };
    this.notify();
  }
};

function safeAsync(fn, fallback = null) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error("[Async Error]:", err);
      if (typeof showGlobalError === 'function') showGlobalError(err.message);
      return fallback;
    }
  };
}

function handleSupabaseError(error, context = "") {
  if (error) {
    console.error(`Supabase Error [${context}]:`, error.message, error.details, error.hint);
    return true;
  }
  return false;
}

function showGlobalError(msg, details = null) {
  console.error("Global Error:", msg);
  if (details) console.error("Details:", details);
}

// ================= SUPABASE INITIALIZATION =================
let supabaseClient = null;
const SUPABASE_URL = "https://qifltzhsbclxvnryjmrq.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFpZmx0emhzYmNseHZucnlqbXJxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwMDQzNjYsImV4cCI6MjA5MTU4MDM2Nn0.eE8SaR_CSI_ItmhE3pXWu8VGia6Efkn8rzZA6mMVqQM";

async function waitForSupabase() {
  let attempts = 0;
  const maxAttempts = 100; // 5 seconds max wait
  while (!window.supabase && attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 50));
    attempts++;
  }
  if (!window.supabase) {
    console.error("Supabase CDN failed to load after 5 seconds");
    return false;
  }
  return true;
}

async function initSupabase() {
  if (supabaseClient) return supabaseClient;

  console.log("[Init] Starting Supabase initialization...");
  const isLoaded = await waitForSupabase();

  if (!isLoaded || !window.supabase?.createClient) {
    throw new Error("Supabase library not available. Please check your connection or script tags.");
  }

  // Robust storage fallback to prevent '__store' null errors in restricted environments
  const getSafeStorage = () => {
    try {
      if (typeof window === "undefined" || !window.localStorage) {
        throw new Error("localStorage not available");
      }
      const testKey = "__storage_test__";
      window.localStorage.setItem(testKey, testKey);
      window.localStorage.removeItem(testKey);
      return window.localStorage;
    } catch (e) {
      console.warn("[Init] Storage restricted or unavailable, using in-memory fallback.");
      const memoryStore = {};
      return {
        getItem: (key) => memoryStore[key] || null,
        setItem: (key, value) => { memoryStore[key] = value; },
        removeItem: (key) => { delete memoryStore[key]; },
        // Add additional methods if library expects them
        clear: () => { Object.keys(memoryStore).forEach(k => delete memoryStore[k]); },
        key: (i) => Object.keys(memoryStore)[i] || null,
        length: Object.keys(memoryStore).length
      };
    }
  };

  const storage = getSafeStorage();
  const isRealLocalStorage = !!(window.localStorage && storage === window.localStorage);

  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: isRealLocalStorage,
      autoRefreshToken: isRealLocalStorage,
      detectSessionInUrl: true,
      storage: storage,
      storageKey: 'brainify-auth-token'
    },
    realtime: {
      params: {
        eventsPerSecond: 10
      }
    }
  });

  console.log("[Init] Supabase client created. Persistence:", isRealLocalStorage);

  // Test connection immediately
  client.from("profiles").select("id").limit(1).then(({ error }) => {
    if (error) {
      console.warn("[Init] Preliminary connection test failed:", error.message);
      if (error.message.includes("JWT") || error.message.includes("Unauthorized")) {
        console.error("[Auth] Critical: The Supabase API Key may be invalid or restricted.");
      }
    } else {
      console.log("[Init] Connection test successful.");
    }
  });
  return client;
}

const WORKER_URL = "https://brainify-proxy.vktikke2005.workers.dev/";

/**
 * Robust AI Communication Helper
 * Centralizes fetch logic, error handling, and JSON extraction.
 */
async function callAI(messages, options = {}) {
  // Convert string to message array if needed for backward compatibility
  if (typeof messages === "string") {
    messages = [{ role: "user", content: messages }];
  }

  const { parseJson = false, maxRetries = 2, timeoutMs = 10000 } = options;
  let lastError = null;

  console.log("[AI REQUEST]:", messages);

  for (let i = 0; i <= maxRetries; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, prompt: messages[messages.length - 1]?.content }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      const rawText = await res.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch (e) {
        data = { reply: `Raw Error: ${rawText}` };
      }

      console.log("[AI RESPONSE RAW]:", data);

      if (!res.ok) {
        const msg = data.reply || `HTTP ${res.status}`;
        throw new Error(msg);
      }

      if (data.reply?.startsWith("Error:")) {
        throw new Error(data.reply);
      }

      if (!data.reply || typeof data.reply !== "string") {
        throw new Error("Malformed response: Missing 'reply' field");
      }

      let text = data.reply.trim();
      if (!parseJson) return text;

      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) text = jsonMatch[1].trim();

      return JSON.parse(text);

    } catch (err) {
      lastError = err;
      const isTimeout = err.name === 'AbortError';
      const errorMsg = isTimeout ? "Request timed out after 10s" : err.message;

      console.warn(`[AI Call] Attempt ${i + 1} failed:`, errorMsg);

      if (i === maxRetries) {
        showGlobalError(`AI Connection Failed: ${errorMsg}`);
      } else {
        await new Promise(r => setTimeout(r, 1500));
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // All retries exhausted — throw so callers land in their catch block
  throw lastError || new Error("AI service unavailable after all retries.");
}

const AI_PROMPT = `Generate ONE highly random, simple, and general quiz topic. 
Think of broad categories like Science, History, Geography, Pop Culture, Sports, or Technology.

Rules:
- Output ONLY plain text
- No JSON, No numbering, No explanation
- 1 to 3 words only
- The topic must be simple, broad, and very common (e.g. "Space Exploration", "Ancient Rome", "Internet History", "Human Biology")
- Avoid niche or overly specific subjects.
- EXTREMELY IMPORTANT: Do NOT repeat or be similar to any of these topics: "{{recentTopics}}"

Return only the topic name.`;

const FALLBACK_TOPICS = [
  "Space Exploration", "Ancient Rome", "Internet History", "Human Biology",
  "World Geography", "Modern Technology", "Classic Literature", "Olympic Games",
  "Wildlife Science", "Renaissance Art", "Ocean Biology", "World War II",
  "Famous Inventors", "Solar System", "Culinary Arts"
];

function getRecentTopics() {
  try {
    const userId = AuthManager.user?.id || "guest";
    const stored = localStorage.getItem(`recent_topics_${userId}`);
    return stored ? JSON.parse(stored) : [];
  } catch (e) {
    return [];
  }
}

function saveRecentTopics(topic) {
  try {
    const userId = AuthManager.user?.id || "guest";
    let list = getRecentTopics();
    if (!list.includes(topic)) {
      list.push(topic);
      if (list.length > 10) list.shift();
      safeSetStorage(`recent_topics_${userId}`, list);
    }
  } catch (e) {
    console.warn("History save failed:", e);
  }
}

function getRandomTopicFromPool() {
  const recent = getRecentTopics();
  const available = FALLBACK_TOPICS.filter(t => !recent.includes(t));
  const pool = available.length > 0 ? available : FALLBACK_TOPICS;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function fetchRandomTopicSafe() {
  if (window.quizLifecycle.state !== "idle") {
    console.warn("[Guard] Random topic generation blocked: Quiz is in progress");
    return;
  }
  const state = Store.get();

  if (state.isFetchingTopic) return null;

  Store.set({ isFetchingTopic: true });
  const recent = getRecentTopics();

  try {
    const prompt = AI_PROMPT.replace("{{recentTopics}}", recent.length > 0 ? recent.join(", ") : "None");

    const raw = await callAI([{
      role: "user",
      content: prompt
    }]);

    if (!raw) throw new Error("Empty AI response");

    let topic = String(raw)
      .replace(/[\n\r]/g, "")
      .replace(/^(Topic|Random Topic|Subject):\s*/i, "")
      .replace(/^[\[\{\d\.\-\s"]+/, "")
      .replace(/[\]\}"]+$/, "")
      .replace(/["']/g, "")
      .trim();

    // Validation & No-Repeat Rule
    if (!topic || topic.length < 3 || recent.includes(topic)) {
      console.log("[Topic] AI duplicate or invalid, using fallback pool...");
      return getRandomTopicFromPool();
    }

    return topic;

  } catch (err) {
    console.error("AI Topic Error:", err);
    return getRandomTopicFromPool();
  } finally {
    Store.set({ isFetchingTopic: false });
  }
}


// Chart instances remain global for destruction
let scoreChartInstance = null;
let difficultyChartInstance = null;
let topicChartInstance = null;
let accuracyChartInstance = null;

function resetQuizState() {
  toggleNewQuizButton(false);

  // Clear UI Containers
  const res = $("quiz-result");
  const pdfRes = $("pdf-quiz-result");
  if (res) res.innerHTML = "";
  if (pdfRes) pdfRes.innerHTML = "";

  const sub = $("submit-quiz-btn");
  const pdfSub = $("pdf-submit-quiz-btn");
  if (sub) { sub.style.display = "block"; sub.textContent = "🚀 Submit Quiz"; }
  if (pdfSub) { pdfSub.style.display = "block"; pdfSub.textContent = "🚀 Submit Quiz"; }

  Store.set({
    currentQuiz: [],
    currentQuizId: null,
    currentAttemptId: null,
    userAnswers: {},
    currentQuestionIndex: 0,
    isQuizReview: false,
    quizStartTime: null
  });
}

// ================= AUTH MANAGER =================
// ================= AUTH MANAGER =================
const AuthManager = {
  user: null,
  session: null,
  isInitialized: false,

  async init() {
    if (!supabaseClient?.auth) {
      console.error("[Auth] Supabase client not initialized.");
      return;
    }

    try {
      const { data: { session }, error } = await supabaseClient?.auth.getSession();
      if (error) throw error;

      await this.setSession(session);
      this.isInitialized = true;
      console.log("[Auth] Initialized. User:", this.user?.email || "None");

      // 🔥 FIX START — OBJECTIVE 3: Hook fullUserReset into onAuthStateChange
      supabaseClient?.auth.onAuthStateChange((event, newSession) => {
        console.log("[Auth] State Change:", event);

        const prevUserId = window._currentSessionUserId || sessionStorage.getItem('brainify_session_user_id');
        const newUserId = newSession?.user?.id || null;

        // Always reset quiz state when user changes
        if (prevUserId !== newUserId) {
          fullUserReset();
          window._currentSessionUserId = newUserId;
          if (newUserId) {
            sessionStorage.setItem('brainify_session_user_id', newUserId);
          } else {
            sessionStorage.removeItem('brainify_session_user_id');
          }
        }

        this.setSession(newSession);

        if (event === 'SIGNED_OUT' || !newSession) {
          Router.go("page-login", { replace: true });
        }
      });
      // 🔥 FIX END
    } catch (err) {
      console.error("[Auth] Init Error:", err);
      this.isInitialized = true; // Still mark as initialized to unblock app
    }
  },

  async setSession(session) {
    this.session = session;
    this.user = session?.user ?? null;

    if (this.user) {
      Store.set({ user: this.user });
      // 1. Fallback to metadata
      let name = this.user.user_metadata?.full_name || this.user.email?.split("@")[0] || "Student";
      const dashName = safeGet("dash-name");
      if (dashName) dashName.textContent = name;

      // 2. Try to fetch fresh profile from DB
      try {
        if (supabaseClient) {
          const { data: profile, error } = await supabaseClient?.from("profiles")
            .select("display_name")
            .eq("id", this.user?.id)
            .maybeSingle();

          if (!error && profile?.display_name) {
            if (dashName) dashName.textContent = profile.display_name;
          }
        }
      } catch (err) {
        console.warn("[Auth] Could not fetch profile:", err);
      }
      this.updateSidebarProfile();
      applyButtonState();
    } else {
      this.clear();
    }
  },

  updateSidebarProfile() {
    const nameEl = $("sidebar-user-name");
    const emailEl = $("sidebar-user-email");
    const avatarEl = $("sidebar-user-avatar");

    if (this.user) {
      const name = this.user.user_metadata?.full_name || this.user.email?.split("@")[0] || "Student";
      const email = this.user.email || "";
      if (nameEl) nameEl.textContent = name;
      if (emailEl) emailEl.textContent = email;
      if (avatarEl) avatarEl.textContent = name.charAt(0).toUpperCase();
    } else {
      if (nameEl) nameEl.textContent = "Guest";
      if (emailEl) emailEl.textContent = "Not logged in";
      if (avatarEl) avatarEl.textContent = "?";
    }
  },

  clear() {
    this.session = null;
    this.user = null;
    Store.reset();
    if (typeof clearAllUI === 'function') clearAllUI();
    const dashName = safeGet("dash-name");
    if (dashName) dashName.textContent = "Student";
    this.updateSidebarProfile();
  }
};

function renderAllData() {
  loadHomeDashboard();
  loadPreviousQuizzes();
  loadChats();
}
// ================= ROUTER =================
const Router = {
  current: null,

  go(pageId, options = {}) {
    console.log("[Router] Navigating to:", pageId);

    // Safety check for common variations
    if (pageId === "login") pageId = "page-login";
    if (pageId === "signup") pageId = "page-signup";

    // Release render locks on every navigation to prevent "stuck" UI
    window.blockAutoRender = false;
    window.isRenderingQuiz = false;


    const target = safeGet(pageId);
    if (!target) {
      console.warn(`[Router] Target page not found: ${pageId}. Falling back to home.`);
      if (pageId !== "home") this.go("home", options);
      return;
    }

    this.current = pageId;
    const isAuthPage = target.classList.contains("auth-page");

    // AUTH GUARD: If not logged in and trying to access protected page
    if (!AuthManager.user && !isAuthPage) {
      console.log("[Router] Auth Guard: Redirecting to login");
      this.go("page-login", { replace: true });
      return;
    }

    // AUTH GUARD: If logged in and trying to access auth pages
    if (AuthManager.user && isAuthPage) {
      console.log("[Router] Auth Guard: Already logged in, going home");
      this.go("home", { replace: true });
      return;
    }

    // Update active nav item highlighting
    document.querySelectorAll(".nav-item").forEach(i => {
      const onclick = i.getAttribute("onclick") || "";
      if (onclick.includes(`'${pageId}'`) || onclick.includes(`"${pageId}"`) ||
        (pageId === "home" && onclick.includes("home"))) {
        i.classList.add("active");
      } else {
        i.classList.remove("active");
      }
    });

    // Persist state for reload recovery
    if (!isAuthPage) {
      localStorage.setItem("brainify_active_view", pageId);
    }

    // Handle App Shell Visibility
    if (isAuthPage) {
      document.body.classList.remove("is-app");
    } else {
      document.body.classList.add("is-app");
    }

    // Switch visibility
    document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
    target.classList.add("active");
    this.updateTopbarTitle(pageId);

    // Load data for the page
    if (!isAuthPage) {
      this.loadPageData(pageId);
    }
  },

  updateTopbarTitle(pageId) {
    const titleEl = document.querySelector(".topbar-title");
    if (!titleEl) return;

    const titles = {
      "home": "Brainify - Home",
      "chat": "Brainify - Chat",
      "quiz": "Brainify - Quiz Generation",
      "pdf": "Brainify - Upload Notes",
      "leaderboard": "Brainify - Leaderboard",
      "dashboard": "Brainify - Dashboard"
    };

    titleEl.textContent = titles[pageId] || "Brainify - AI Tutor";
  },

  async loadPageData(pageId) {
    try {
      renderAllData(); // Core data

      if (pageId === "leaderboard" && typeof loadLeaderboard === 'function') {
        await loadLeaderboard();
      } else if (pageId === "dashboard" && typeof loadDashboard === 'function') {
        await loadDashboard();
      }
    } catch (err) {
      console.error(`[Router] Failed to load data for ${pageId}:`, err);
    }
  },

  resolveInitialRoute() {
    const hash = window.location.hash.replace("#", "");
    const saved = localStorage.getItem("brainify_active_view");

    // Primary authority: Auth state
    if (!AuthManager.user) {
      return (hash === "signup" || hash === "page-signup") ? "page-signup" : "page-login";
    }

    // If logged in, prioritize saved view or hash, but never auth pages
    if (hash === "login" || hash === "signup" || hash === "page-login" || hash === "page-signup") {
      window.location.hash = "";
      return saved || "home";
    }

    return hash || saved || "home";
  }
};

// Global safe load wrapper
async function safeLoad(fn) {
  try {
    await fn();
  } catch (err) {
    console.error("Load Error:", err);
  }
}

// ================= APP INITIALIZATION PIPELINE =================
let appInitialized = false;

async function initApp() {
  console.log("[Init] Starting Brainify App Pipeline...");

  try {
    // 1. Initialize Supabase Client
    supabaseClient = await initSupabase();

    // 2. Initialize Auth Manager
    await AuthManager.init();

    // 3. Set App State
    appInitialized = true;

    // 5. Resolve and Navigate to Initial Route
    const initialRoute = Router.resolveInitialRoute();
    Router.go(initialRoute);

    // 6. Restore Side Effects
    setupKeyboardListeners();
    setupUIComponents();
    if (AuthManager.user) {
      initializeUserSession();
    }

    console.log("[Init] App Pipeline completed successfully.");
    applyButtonState(); // Sync initial button states
    registerServiceWorker();

    // Hide loading screen
    const loadingScreen = $("app-loading");
    if (loadingScreen) {
      loadingScreen.classList.add("fade-out");
      setTimeout(() => loadingScreen.remove(), 500);
    }
  } catch (err) {
    console.error("[Init] Critical Initialization Failure:", err);
    showGlobalError("Brainify failed to start. Check your internet connection or console for details.");

    // Fallback to login screen if possible
    if (Router) Router.go("page-login");

    // Hide loading screen even on error
    const loadingScreen = $("app-loading");
    if (loadingScreen) {
      loadingScreen.classList.add("fade-out");
      setTimeout(() => loadingScreen.remove(), 500);
    }
  }
}

// ================= USER SESSION INITIALIZATION =================
// Called once after login, signup, or on page load if already logged in.
// Must be idempotent — safe to call multiple times (guards prevent duplicates).
let _sessionInitialized = false;
function initializeUserSession() {
  if (!AuthManager.user) return;

  const lastChatId = localStorage.getItem("brainify_active_chat");
  if (lastChatId) Store.set({ activeChatId: lastChatId });

  // Load non-critical subsystems (delayed to not block navigation)
  setTimeout(() => {
    if (!_sessionInitialized) {
      subscribeToQuizzes();
      subscribeToChats();
      initStoreSubscriptions();
      migrateOldChats();
      if (typeof initResizeHandles === 'function') initResizeHandles();
      _sessionInitialized = true;

      // RESTORE ACTIVE QUIZ STATE
      if (window.activeQuizContext && window.activeQuizContext.quizId) {
        console.log("[Init] Restoring active quiz:", window.activeQuizContext.quizId);
        loadAttempt(window.activeQuizContext.quizId);
      }
    } else {
      // Already subscribed — just reload the data
      loadPreviousQuizzes();
      loadChats();
    }
  }, 100);
}

// ================= REAL-TIME & STORE SUBSCRIPTIONS =================
function initStoreSubscriptions() {
  console.log("[Store] Initializing UI Subscriptions...");

  Store.subscribe((state) => {
    console.log("[Store] State Change:", state);

    // Sidebar Chat
    renderChatList(state.chats);

    // Dashboard / Quiz History
    renderPreviousAttempts(state.quizzes);

    // Active UI elements
    highlightActiveChat();
  });
}

function subscribeToQuizzes() {
  if (!supabaseClient) return;
  console.log("[Sync] Subscribing to Quizzes...");

  supabaseClient
    .channel('quizzes-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'quiz_attempts' }, () => loadPreviousQuizzes())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'quiz' }, () => loadPreviousQuizzes())
    .subscribe((status, err) => {
      console.log("[Sync] Quizzes subscription status:", status);
      if (err) console.error("[Sync] Quizzes subscription error:", err);
      if (status === 'CHANNEL_ERROR') {
        console.warn("[Sync] Realtime access restricted. Check RLS policies on 'quiz_attempts' and 'quiz' tables.");
      }
    });
}

function subscribeToChats() {
  if (!supabaseClient) return;
  console.log("[Sync] Subscribing to Chats...");

  supabaseClient
    .channel('chats-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chat' }, () => loadChats())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_messages' }, (payload) => {
      if (Store.state.activeChatId === payload.new?.chat_id && !window._isSendingMessage) {
        loadChatMessages(Store.state.activeChatId);
      }
    })
    .subscribe((status, err) => {
      console.log("[Sync] Chats subscription status:", status);
      if (err) console.error("[Sync] Chats subscription error:", err);
      if (status === 'CHANNEL_ERROR') {
        console.warn("[Sync] Realtime access restricted for 'chat' tables.");
      }
    });
}

let listenersInitialized = false;
function setupKeyboardListeners() {
  if (listenersInitialized) return;

  const listeners = [
    { id: "chat-input", fn: sendMessage },
    { id: "quiz-topic", fn: startQuiz },
    { id: "quiz-count", fn: startQuiz },
    { id: "file-quiz-count", fn: generateQuizFromFile },
    { id: "login-password", fn: loginUser },
    { id: "signup-password", fn: signUpUser }
  ];

  listeners.forEach(l => {
    const el = $(l.id);
    if (el) {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          l.fn();
        }
      });
    }
  });
  listenersInitialized = true;
  console.log("[Init] Keyboard listeners attached.");
}

// Ensure initApp only runs once and when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}

// Aliases for compatibility
function goTo(pageId, navEl = null) {
  Router.go(pageId);
}
function switchView(viewId, el) {
  Router.go(viewId);
}

// ================= AUTH METHODS =================
function validatePassword(password) {
  const strongRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_])[^\s]{8,}$/;

  if (!password) {
    return { valid: false, message: "Password is required" };
  }

  if (!strongRegex.test(password)) {
    return {
      valid: false,
      message: "Password must be 8+ chars, include uppercase, lowercase, number, and special character"
    };
  }

  return { valid: true };
}

async function signUpUser() {
  const name = $("signup-name")?.value?.trim() || "";
  const email = $("signup-email")?.value?.trim() || "";
  const password = $("signup-password")?.value || "";
  const phone = $("signup-phone")?.value?.trim() || "";

  // Clear previous phone error
  const phoneErrEl = $("phone-error-msg");
  if (phoneErrEl) { phoneErrEl.style.display = "none"; phoneErrEl.textContent = ""; }

  if (!name || !email || !password) return alert("Please fill in all fields.");

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return alert("Please enter a valid email address (e.g. name@example.com).");

  // Validate phone number — exactly 10 digits, numbers only
  if (!phone) {
    if (phoneErrEl) { phoneErrEl.textContent = "Phone number is required."; phoneErrEl.style.display = "block"; }
    $("signup-phone")?.focus();
    return;
  }
  if (!/^\d+$/.test(phone)) {
    if (phoneErrEl) { phoneErrEl.textContent = "Phone number must contain only numbers."; phoneErrEl.style.display = "block"; }
    $("signup-phone")?.focus();
    return;
  }
  if (phone.length !== 10) {
    if (phoneErrEl) { phoneErrEl.textContent = "Phone number must be exactly 10 digits."; phoneErrEl.style.display = "block"; }
    $("signup-phone")?.focus();
    return;
  }

  const validation = validatePassword(password);
  if (!validation.valid) return; // silently block — button should already be disabled

  // Clear previous user's data before signup
  // 🔥 FIX START — OBJECTIVE 3: Call fullUserReset before signup
  fullUserReset();
  window._currentSessionUserId = null;
  sessionStorage.removeItem('brainify_session_user_id');
  AuthManager.clear();
  // 🔥 FIX END

  const { data, error } = await supabaseClient?.auth.signUp({
    email, password, options: { data: { full_name: name, phone_number: phone } }
  });

  if (error) return alert(error.message);
  if (!data.session) return alert("Signup successful. Please check your email or log in.");

  await AuthManager.setSession(data.session);
  window.location.hash = ""; // Clean hash

  try {
    const displayName = name || email.split("@")[0];
    const { error: syncError } = await supabaseClient?.from("profiles").upsert({
      id: AuthManager.user?.id,
      display_name: displayName,
      phone_number: phone
    });
    if (syncError) console.warn("[Auth] Profile sync failed:", syncError.message);
  } catch (err) {
    console.error("[Auth] Profile sync exception:", err);
  }

  // 🔥 FIX START — OBJECTIVE 3: fullUserReset replaces scattered state patches
  window._currentSessionUserId = AuthManager.user?.id || null;
  fullUserReset();
  console.log("[Auth] fullUserReset called after Signup");
  // 🔥 FIX END

  // Initialize subscriptions & load history for the newly signed-up user
  _sessionInitialized = false; // Reset so subscriptions are freshly created
  initializeUserSession();

  Router.go("home");
}

async function loginUser() {
  const email = $("login-email")?.value?.trim() || "";
  const password = $("login-password")?.value || "";

  if (!email || !password) return alert("Please enter email and password.");

  // Clear previous user's data before login
  AuthManager.clear();

  let data, error;
  let retries = 3;

  while (retries > 0) {
    try {
      const res = await supabaseClient?.auth.signInWithPassword({ email, password });
      data = res.data;
      error = res.error;
      break;
    } catch (err) {
      console.warn(`Login attempt failed (${retries} retries left):`, err);
      retries--;
      if (retries === 0) {
        return alert("Network error: Failed to reach login server after multiple attempts. Please check your internet or try a different network.");
      }
      await new Promise(r => setTimeout(r, 2000)); // wait 2s before retry
    }
  }

  if (error) return alert(error.message);
  if (!data.session) return alert("Session not created. Try again.");

  await AuthManager.setSession(data.session);
  window.location.hash = ""; // Clean hash

  try {
    const displayName = data.user.user_metadata?.full_name || email.split("@")[0];
    const { error: syncError } = await supabaseClient?.from("profiles").upsert({
      id: AuthManager.user?.id,
      display_name: displayName
    });
    if (syncError) console.warn("[Auth] Profile sync failed:", syncError.message);
  } catch (err) {
    console.error("[Auth] Profile sync exception:", err);
  }

  // 🔥 FIX START — OBJECTIVE 3: fullUserReset replaces scattered state patches
  window._currentSessionUserId = AuthManager.user?.id || null;
  fullUserReset();
  console.log("[Auth] fullUserReset called after Login");
  // 🔥 FIX END

  // Initialize subscriptions & load history for the newly logged-in user
  _sessionInitialized = false; // Reset so subscriptions are freshly created
  initializeUserSession();

  Router.go("home");
}

// 🔥 FIX START — OBJECTIVE 3: logoutUser uses fullUserReset + targeted localStorage clear
async function logoutUser() {
  // Reset all quiz state first
  fullUserReset();
  window._currentSessionUserId = null;
  sessionStorage.removeItem('brainify_session_user_id');
  _sessionInitialized = false; // Allow fresh subscriptions on next login
  // Only clear non-essential keys — don't nuke sidebar_width etc.
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith("quiz_") || k === "brainify_active_view" || k === "brainify_active_chat")
      .forEach(k => localStorage.removeItem(k));
  } catch (e) { /* storage unavailable */ }
  AuthManager.clear();
  await supabaseClient?.auth.signOut();
  document.body.classList.remove("is-app");
  window.location.hash = ""; // Clean hash
  Router.go("page-login");
}
// 🔥 FIX END

// ================= CHAT =================
let currentChatMessages = []; // in-memory messages for active chat

// ── Load chat list into sidebar + open the most recent ──
async function loadChats() {
  if (!AuthManager.user) { Router.go("page-login"); return; }

  const { data: chats, error } = await supabaseClient?.from("chat").select("*")
    .eq("user_id", AuthManager.user?.id)
    .order("created_at", { ascending: false });

  if (error) { console.error("Load chats error:", error); return; }

  const allChats = chats || [];
  Store.set({ chats: allChats });

  const { activeChatId } = Store.state;
  if (activeChatId && allChats.some(c => String(c.chat_id) === String(activeChatId))) {
    if (!window._isSendingMessage) {
      await loadChatMessages(activeChatId);
    }
  } else if (allChats.length > 0) {
    await switchChat(allChats[0].chat_id);
  } else {
    Store.set({ activeChatId: null });
    showChatEmptyState();
  }
}

// ── Render the sidebar chat list ──
function renderChatList(chats) {
  const list = $("chat-history-list");
  if (!list) return;

  if (!chats || chats.length === 0) {
    list.innerHTML = `
      <div class="chat-empty-state-sidebar" style="text-align:center;padding:32px 12px;color:var(--text-muted);font-size:12px;line-height:1.6;">
        <div style="font-size:24px;margin-bottom:8px;opacity:0.5;">💬</div>
        No conversations yet.<br>Click <b style="color:var(--accent)">＋ New</b> to start!
      </div>`;
    return;
  }

  list.innerHTML = chats.map(chat => {
    const isActive = chat.chat_id === Store.state.activeChatId;
    const title = chat.title || chat.message || "New Chat";
    const displayTitle = title.length > 30 ? title.substring(0, 30) + "…" : title;
    const timeAgo = formatTimeAgo(chat.created_at);

    return `
      <div class="chat-history-item ${isActive ? 'active' : ''}"
           data-chat-id="${chat.chat_id}"
           onclick="switchChat('${chat.chat_id}')">
        <div class="chat-history-icon">💬</div>
        <div class="chat-history-info">
          <div class="chat-history-name">${escapeHTML(displayTitle)}</div>
          <div class="chat-history-time">${timeAgo}</div>
        </div>
        <button class="chat-history-delete" onclick="event.stopPropagation(); deleteChat('${chat.chat_id}')" title="Delete chat">✕</button>
      </div>`;
  }).join("");
}

function highlightActiveChat() {
  document.querySelectorAll(".chat-history-item").forEach(el => {
    el.classList.toggle("active", el.dataset.chatId === String(Store.state.activeChatId));
  });
}

// ── Switch to a specific chat ──
async function switchChat(chatId) {
  removeChatAttachment();
  Store.set({ activeChatId: chatId });
  localStorage.setItem("brainify_active_chat", chatId); // Persist active chat
  await loadChatMessages(chatId);
}

// ── Load messages for a specific chat ──
async function loadChatMessages(chatId) {
  const box = $("chat-messages");
  if (!box) return;
  box.innerHTML = "";
  currentChatMessages = [];

  const { data: messages, error } = await supabaseClient?.from("chat_messages").select("*")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true });

  if (error) { console.error("Load messages error:", error); return; }

  if (messages && messages.length > 0) {
    // Always prepend the AI's greeting message at the start of the thread
    addMessage("Hi! I'm Brainify 🧠 — your AI tutor. Ask me anything!", "ai", false);

    currentChatMessages = messages.map(m => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content
    }));
    messages.forEach(m => addMessage(m.content, m.role === "user" ? "user" : "ai", false));
    box.scrollTop = box.scrollHeight;
  } else {
    showChatStartUI();
  }
}

// ── Create a new chat session ──
async function createNewChat() {
  if (!AuthManager.user) { Router.go("page-login"); return; }

  // Try inserting with title; fall back without it if column doesn't exist
  let newChat = null;
  let { data, error } = await supabaseClient
    .from("chat").insert({
      user_id: AuthManager.user?.id,
      message: "New Chat",
      title: "New Chat"
    })
    .select().maybeSingle();

  if (error && error.message?.includes("title")) {
    // title column may not exist yet — insert without it
    const res = await supabaseClient
      .from("chat").insert({ user_id: AuthManager.user?.id, message: "New Chat" })
      .select().maybeSingle();
    data = res.data;
    error = res.error;
  }

  if (error) { console.error("Create chat error:", error); return; }
  newChat = data;

  Store.set({
    activeChatId: newChat.chat_id,
    chats: [newChat, ...Store.state.chats]
  });
  currentChatMessages = [];

  // Clear messages and show welcome
  const box = $("chat-messages");
  if (!box) return;
  box.innerHTML = "";
  showChatStartUI();

  // Focus the input
  $("chat-input")?.focus();
}

// ── Delete a chat session ──
async function deleteChat(chatId) {
  if (!confirm("Delete this conversation?")) return;

  // 1. Instant UI update (Optimistic)
  const chatItem = document.querySelector(`.chat-history-item[data-chat-id="${chatId}"]`);
  if (chatItem) {
    chatItem.classList.add('fade-out');
  }

  // Update local state immediately
  // Update local state immediately
  Store.set({ chats: Store.state.chats.filter(c => c.chat_id !== chatId) });

  // If we deleted the active chat, clear the messages window
  if (Store.state.activeChatId === chatId) {
    Store.set({ activeChatId: null });
    showChatEmptyState();
  }

  try {
    // 2. Database delete (Background)
    const { error } = await supabaseClient?.from("chat").delete().eq("chat_id", chatId);

    if (error) {
      console.error("Delete failed:", error);
      // Optional: alert("Delete failed, but UI is updated. Syncing...");
    }
  } catch (e) {
    console.error("Delete exception:", e);
  }

  // 3. Safety re-fetch (Sync fallback)
  await loadChats();
}

// Unified real-time chat sync is handled by subscribeToChats()

// ── Show empty state when no chat is selected ──
function showChatEmptyState() {
  const box = $("chat-messages");
  if (!box) return;
  box.innerHTML = `
    <div class="chat-empty-state">
      <div class="chat-empty-icon">🧠</div>
      <div class="chat-empty-title">Start a Conversation</div>
      <div class="chat-empty-sub">Click <b>＋ New</b> to begin a new chat with your AI tutor.</div>
    </div>`;
}

function showChatStartUI() {
  const box = $("chat-messages");
  if (!box) return;
  box.innerHTML = `
    <div class="chat-start-container">
      <div class="chat-start-header">
        <h2 class="chat-start-title">How can I help you learn today?</h2>
        <p class="chat-start-subtitle">Ask your Brainify AI tutor anything, or upload a document to get started.</p>
      </div>
    </div>
  `;
}

// ── Chat file attachment state & handlers ──
Object.defineProperty(window, 'currentChatFileText', {
  get: () => sessionStorage.getItem('brainify_chat_file_text') || "",
  set: (val) => { if (val) sessionStorage.setItem('brainify_chat_file_text', val); else sessionStorage.removeItem('brainify_chat_file_text'); }
});
Object.defineProperty(window, 'currentChatFileName', {
  get: () => sessionStorage.getItem('brainify_chat_file_name') || "",
  set: (val) => { if (val) sessionStorage.setItem('brainify_chat_file_name', val); else sessionStorage.removeItem('brainify_chat_file_name'); }
});

function triggerChatUpload() {
  const fileInput = $("chat-file-input");
  if (fileInput) {
    fileInput.value = ""; // Clear to allow uploading the same file again if needed
    fileInput.click();
  }
}
window.triggerChatUpload = triggerChatUpload;

async function handleChatFileSelect(input) {
  if (input.files && input.files[0]) {
    const file = input.files[0];
    const previewContainer = $("chat-attachment-preview");
    const nameEl = $("chat-attachment-name");
    const uploadBtn = $("chat-upload-btn");

    try {
      if (uploadBtn) uploadBtn.innerHTML = "⏳";
      const extractedText = await extractTextFromFile(file);

      window.currentChatFileText = extractedText;
      window.currentChatFileName = file.name;

      if (nameEl) nameEl.textContent = file.name;
      if (previewContainer) previewContainer.style.display = "flex";

      console.log("[Chat File] Loaded file text length:", extractedText.length);
    } catch (err) {
      alert("Error reading document: " + err.message);
      removeChatAttachment();
    } finally {
      if (uploadBtn) uploadBtn.innerHTML = "📎";
    }
  }
}
window.handleChatFileSelect = handleChatFileSelect;

function removeChatAttachment() {
  window.currentChatFileText = "";
  window.currentChatFileName = "";
  const fileInput = $("chat-file-input");
  if (fileInput) fileInput.value = "";
  const previewContainer = $("chat-attachment-preview");
  if (previewContainer) previewContainer.style.display = "none";
}
window.removeChatAttachment = removeChatAttachment;

// ── Filter / search chats ──
function filterChatList(query) {
  const q = query.toLowerCase().trim();
  const { chats } = Store.get();
  if (!q) {
    renderChatList(chats);
    return;
  }
  const filtered = chats.filter(c => {
    const title = (c.title || c.message || "").toLowerCase();
    return title.includes(q);
  });
  renderChatList(filtered);
}

// ── Send message ──
// ── Migration for old unnamed chats ──
async function migrateOldChats() {
  if (!AuthManager.user || window._migrationStarted) return;
  window._migrationStarted = true;

  try {
    const { data: chats } = await supabaseClient?.from("chat")
      .select("chat_id, title, message")
      .eq("user_id", AuthManager.user.id)
      .or('title.eq.New Chat,title.eq.session,title.is.null')
      .limit(10); // Batch of 10 to avoid overloading

    if (!chats || chats.length === 0) return;

    console.log(`[Migration] Found ${chats.length} chats needing titles.`);

    for (const chat of chats) {
      // Get first message for context
      const { data: msgs } = await supabaseClient?.from("chat_messages")
        .select("content")
        .eq("chat_id", chat.chat_id)
        .eq("role", "user")
        .order("created_at", { ascending: true })
        .limit(1);

      const context = msgs?.[0]?.content || chat.message;
      if (!context || context === "New Chat" || context === "session") continue;

      try {
        const aiTitle = await callAI([{
          role: "user",
          content: `Summarize this chat starter into a 3-word title: "${context.substring(0, 80)}". ONLY TEXT.`
        }]);

        if (aiTitle) {
          await supabaseClient?.from("chat")
            .update({ title: aiTitle, message: aiTitle })
            .eq("chat_id", chat.chat_id);
        }
      } catch (e) { console.warn("Migration step failed:", e); }
    }

    // Refresh if we changed anything
    loadChats();
  } catch (err) {
    console.error("Migration failed:", err);
  }
}

async function sendMessage() {
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;

  window._isSendingMessage = true;
  try {
    const { activeChatId } = Store.get();
    if (!activeChatId) {
      if (window._isCreatingChat) return;
      window._isCreatingChat = true;
      try { await createNewChat(); } finally { window._isCreatingChat = false; }
    }

    const currentId = Store.state.activeChatId;

    // Construct user message with attachment context if present
    let userMsgContent = text;
    if (window.currentChatFileText) {
      userMsgContent = `[File: ${window.currentChatFileName}]\n[Content: ${window.currentChatFileText}]\n\n${text}`;
    }

    addMessage(userMsgContent, "user", true);
    input.value = "";
    sessionStorage.removeItem('brainify_chat_draft');

    // Clear the attachment UI & state after sending
    removeChatAttachment();

    currentChatMessages.push({ role: "user", content: userMsgContent });

    // Save user message to database
    await supabaseClient?.from("chat_messages").insert({
      chat_id: currentId,
      user_id: AuthManager.user?.id,
      role: "user",
      content: userMsgContent
    });

    // Background: Auto-title if needed
    const { chats } = Store.get();
    const chatInList = chats.find(c => c.chat_id === currentId);
    if (chatInList && (chatInList.title === "New Chat" || chatInList.title === "session")) {
      (async () => {
        try {
          const aiTitle = await callAI([{
            role: "user",
            content: `Generate a concise 3-4 word title for a conversation starting with: "${text.substring(0, 100)}". RETURN ONLY THE TITLE.`
          }], {});
          if (aiTitle) {
            const cleanTitle = aiTitle.replace(/["']/g, "").trim();
            await supabaseClient?.from("chat").update({ title: cleanTitle }).eq("chat_id", currentId);
            loadChats();
          }
        } catch (e) { console.debug("Titling skipped:", e.message); }
      })();
    }

    const typingId = showTyping();
    try {
      const promptContent = [
        {
          role: "system",
          content: `You are an AI assistant inside a quiz web app. Follow STRICT formatting, behavior, and interaction rules.

========================
🎯 OUTPUT STYLE RULES
========================
1. NO MARKDOWN EVER: Do NOT use ##, ###, ####, **bold**, *italics*, backticks \`, or bullets (-, *, •).
2. CLEAN CHAT FORMAT ONLY: Write in natural paragraphs with double spacing between sections. Use simple labels like "Step 1:" instead of symbols.
3. STRUCTURE: Start with a direct answer, then explain, then use steps for processes. Use natural language formatting.
4. TONE: Friendly and conversational.

========================
🎯 QUIZ INTERACTION LOGIC (VERY IMPORTANT)
========================
If the user asks for a quiz (e.g., "generate quiz", "make quiz", "start quiz"):
1. DO NOT generate the quiz immediately.
2. ALWAYS respond by asking: "Sure, I can create a quiz for you. Please tell me the Topic (example: Science, History, Coding) and the Number of questions."
3. Wait for their response.
4. Only generate the quiz JSON after you have BOTH the Topic and the Number of questions.

========================
📌 QUIZ FORMAT (WHEN GENERATING)
========================
Generate questions one by one in this clean format:
Question 1: [Question text]
Options:
A. [Option]
B. [Option]
C. [Option]
D. [Option]

(No markdown or symbols allowed).`
        },
        ...currentChatMessages.slice(-10)
      ];

      const reply = await callAI(promptContent);
      removeTyping(typingId);
      addMessage(reply, "assistant", true);
      currentChatMessages.push({ role: "assistant", content: reply });

      await supabaseClient?.from("chat_messages").insert({
        chat_id: currentId, user_id: AuthManager.user?.id, role: "assistant", content: reply
      });
    } catch (err) {
      removeTyping(typingId);
      console.error("[Chat Error]:", err);
      addMessage("I'm having trouble connecting right now. Please try again in a moment.", "assistant", true);
      showGlobalError(`AI Error: ${err.message}`);
    }
  } finally {
    window._isSendingMessage = false;
  }
}

function formatQuizForChat(quizData) {
  let html = `<div class="chat-quiz-container">
    <div style="font-weight:600;margin-bottom:12px;color:var(--accent);">🧠 AI Generated Quiz</div>`;

  quizData.forEach((q, i) => {
    html += `<div style="margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.05);">
      <div style="font-weight:500;margin-bottom:8px;">${i + 1}. ${q.question}</div>
      <div style="display:flex;flex-direction:column;gap:6px;padding-left:12px;">`;

    q.options.forEach((opt, oi) => {
      html += `<div style="font-size:13px;color:var(--text-secondary);"><span style="color:var(--accent);margin-right:8px;font-weight:600;">${String.fromCharCode(65 + oi)}.</span> ${opt}</div>`;
    });

    html += `</div></div>`;
  });

  html += `<button class="btn-submit" onclick="switchView('quiz', document.querySelector('.nav-item[onclick*=\\'quiz\\']'))" style="width:auto;padding:8px 16px;font-size:12px;margin-top:8px;">▶ Take Quiz in Quiz Section</button>
  </div>`;
  return html;
}

function formatAIResponse(text) {
  if (!text) return "";

  // Try to format as quiz if it's JSON
  const quizFormatted = formatQuizResponse(text);
  if (quizFormatted) return quizFormatted;

  return text
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, "<br>")
    .replace(/### (.*?)<br>/g, "<h4>$1</h4>")
    .replace(/## (.*?)<br>/g, "<h3>$1</h3>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/- (.*?)(<br>|$)/g, "<li>$1</li>")
    .replace(/(<li>.*<\/li>)/g, "<ul>$1</ul>");
}

function formatQuizResponse(text) {
  try {
    // Look for JSON array pattern in the text
    const jsonMatch = text.match(/\[\s*\{\s*"question":[\s\S]*?\}\s*\]/);
    if (!jsonMatch) return null;

    const quizData = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(quizData)) return null;

    let formatted = "";
    quizData.forEach((q, i) => {
      formatted += `Q${i + 1}. ${q.question}\n`;
      if (q.options && Array.isArray(q.options)) {
        q.options.forEach((opt, oi) => {
          formatted += `${String.fromCharCode(65 + oi)}. ${opt}\n`;
        });
      }
      formatted += `\n`;
    });

    // If we have a formatted string, wrap it for style
    if (formatted) {
      return `<div class="formatted-quiz">${formatted.trim()}</div>`;
    }
    return null;
  } catch (e) {
    return null;
  }
}

function addMessage(text, type, scroll = true) {
  const box = $("chat-messages");
  if (!box) return;
  // Remove empty state if present
  const emptyState = box.querySelector(".chat-empty-state");
  if (emptyState) emptyState.remove();
  const startUI = box.querySelector(".chat-start-container");
  if (startUI) startUI.remove();

  const msg = document.createElement("div");
  msg.className = "message " + type; // user-requested class

  let content = text;
  let bubbleClass = "msg-bubble";

  if (type === "ai" && !text.includes("chat-quiz-container")) {
    content = formatAIResponse(text);
  } else if (type === "user") {
    content = parseUserMessage(text);
  }
  bubbleClass = "msg-bubble " + (type === "user" ? "user-bubble" : "ai-bubble");

  msg.innerHTML = `<div class="${bubbleClass}">${content}</div>`;
  box.appendChild(msg);
  if (scroll) box.scrollTop = box.scrollHeight;
}

function parseUserMessage(text) {
  if (text && text.startsWith("[File: ")) {
    const match = text.match(/^\[File: ([^\]]+)\]\n\[Content: ([\s\S]*?)\]\n\n([\s\S]*)$/);
    if (match) {
      const fileName = match[1];
      const userText = match[3];
      return `
        <div class="message-file-chip">
          <span class="chip-icon">📄</span>
          <span class="chip-name" title="${fileName}">${fileName}</span>
        </div>
        <div class="message-text-content">${userText}</div>
      `;
    }
  }
  return text;
}

function showTyping() {
  const box = $("chat-messages");
  if (!box) return;
  const id = "typing-" + Date.now();
  const msg = document.createElement("div");
  msg.className = "message ai typing"; msg.id = id;
  msg.innerHTML = `<div class="msg-bubble"><span class="typing-dots"><span>.</span><span>.</span><span>.</span></span></div>`;
  box.appendChild(msg);
  box.scrollTop = box.scrollHeight;
  return id;
}

function removeTyping(id) {
  const el = $(id, true); // silent = true
  if (el) el.remove();
}

// ── Utility: format relative time ──
function formatTimeAgo(dateStr) {
  if (!dateStr) return '';
  const now = new Date();
  // Supabase returns UTC but may omit 'Z'. Force UTC parsing:
  const normalized = dateStr.endsWith('Z') || dateStr.includes('+') ? dateStr : dateStr + 'Z';
  const date = new Date(normalized);
  if (isNaN(date.getTime())) return '';
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Utility: escape HTML ──
function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ================= HOME DASHBOARD =================
async function loadHomeDashboard() {
  if (!AuthManager.user) { Router.go("page-login"); return; }
  // Use loadDashboard as the single source of truth for stats
  await loadDashboard();
}

function renderEmptyHomeState() {
  const stats = ["home-stat-total", "home-stat-avg", "home-stat-best", "home-stat-accuracy", "home-stat-time"];
  stats.forEach(id => {
    const el = $(id);
    if (el) el.textContent = id === "home-stat-accuracy" ? "0%" : "0";
  });

  const homeRecent = $("home-recent-activity");
  if (homeRecent) {
    homeRecent.innerHTML = `
      <div style="text-align:center;color:var(--text-muted);padding:40px 20px;font-size:13px;">
        No quiz attempts yet.<br><br>
        Go to <a onclick="goTo('quiz')" style="color:var(--accent);cursor:pointer;font-weight:600;">Quiz</a> to generate your first quiz! 🚀
      </div>`;
  }

  const chartContainer = $("home-chart-container");
  if (chartContainer) chartContainer.style.display = "none";
  if (homeScoreChartInstance) {
    homeScoreChartInstance.destroy();
    homeScoreChartInstance = null;
  }
}

function clearAllUI() {
  console.log("[UI] Clearing all user data from interface...");
  renderEmptyHomeState();

  // Clear dashboard stats
  ["stat-total", "stat-avg", "stat-best", "stat-accuracy", "stat-streak", "stat-topics"]
    .forEach(id => {
      const el = $(id);
      if (el) el.textContent = id === "stat-accuracy" ? "0%" : "0";
    });

  // Clear dashboard charts
  [scoreChartInstance, difficultyChartInstance, topicChartInstance, accuracyChartInstance].forEach(c => {
    if (c && typeof c.destroy === 'function') c.destroy();
  });
  scoreChartInstance = difficultyChartInstance = topicChartInstance = accuracyChartInstance = null;

  // Show placeholders for charts
  ['scoreChart', 'accuracyChart', 'difficultyChart', 'topicChart'].forEach(id => {
    const p = $(id + '-placeholder');
    const c = $(id);
    if (p) p.style.display = 'block';
    if (c) c.style.display = 'none';
  });

  // Clear lists (these will also be cleared by Store.subscribe, but this is immediate)
  renderPreviousAttempts([]);
  renderChatList([]);

  // Reset PDF/Notes UI
  const selectedFile = $("selected-file-info");
  if (selectedFile) selectedFile.style.display = "none";
  const quizConfig = $("file-quiz-config");
  if (quizConfig) quizConfig.style.display = "none";
}

let homeScoreChartInstance = null;

function renderHomeScoreChart(attempts) {
  const container = $("home-chart-container");
  if (!container) return;

  // Show container
  container.style.display = "block";

  // Get last 7 attempts
  const chartData = attempts.slice(0, 7).reverse();

  const labels = chartData.map((_, idx) => `Quiz ${idx + 1}`);
  const scores = chartData.map(a => a.score);

  const ctx = $("homeScoreChart");
  if (!ctx) return;

  if (homeScoreChartInstance) {
    homeScoreChartInstance.destroy();
  }

  homeScoreChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Score",
        data: scores,
        borderColor: "#20D296",
        backgroundColor: (context) => {
          const chart = context.chart;
          const { ctx, chartArea } = chart;
          if (!chartArea) return null;
          const gradient = ctx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
          gradient.addColorStop(0, "rgba(32,210,150,0)");
          gradient.addColorStop(1, "rgba(32,210,150,0.2)");
          return gradient;
        },
        borderWidth: 3,
        tension: 0.45,
        pointBackgroundColor: "#20D296",
        pointBorderColor: "rgba(255,255,255,0.2)",
        pointBorderWidth: 2,
        pointRadius: 5,
        pointHoverRadius: 7,
        fill: true,
        shadowBlur: 10,
        shadowColor: "rgba(32,210,150,0.5)",
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          ticks: { color: "rgba(240,244,255,0.4)", font: { size: 10 } },
          grid: { display: false }
        },
        y: {
          ticks: { color: "rgba(240,244,255,0.4)", font: { size: 10 } },
          grid: { color: "rgba(255,255,255,0.03)", drawBorder: false },
          beginAtZero: true
        }
      }
    }
  });
}


// ================= QUIZ =================
async function startQuiz() {
  if (window.quizLifecycle.state !== "idle") return;
  if (window.isGenerating) return;

  try {
    window.isGenerating = true;

    // 🔥 Context Reset
    resetEntireQuizEnvironment();
    window.activeQuizContext.mode = "new";

    const topicInput = $("quiz-topic");
    const countInput = $("quiz-count");
    const topic = topicInput ? topicInput.value.trim() : "";
    const count = countInput ? countInput.value.trim() : "";
    const difficulty = $("quiz-difficulty")?.value || "medium";

    if (!topic || !count) {
      showQuizError("❌ Please fill in all fields", "Fill topic and number of questions to continue.");
      return;
    }

    // 🔒 Question count limit validation
    const numCount = parseInt(count, 10);
    if (isNaN(numCount) || numCount < 1) {
      showQuizError("❌ Invalid Question Count", "Please enter a valid number of questions (1–50).");
      return;
    }
    if (numCount > MAX_QUIZ_QUESTIONS) {
      showQuizError("⚠️ Question Limit Exceeded", QUESTION_LIMIT_ERROR_MSG);
      return;
    }

    // ── 1. Preparation ──
    clearQuizLoaderIntervals();
    resetQuizState();
    window.scrollTo({ top: 0, behavior: "smooth" });

    const submitBtn = $("submit-quiz-btn");
    const resultDiv = $("quiz-result");
    const btn = document.querySelector("#quiz .generate-btn") || document.querySelector("#quiz button.btn-submit");

    if (submitBtn) submitBtn.style.display = "none";
    if (resultDiv) resultDiv.innerHTML = "";
    if (btn) btn.textContent = "⏳ Brewing Brain Teasers...";

    showQuizLoading();

    const difficultyInstructions = {
      easy: "Focus on basic concepts and fundamental definitions. Questions should be straightforward.",
      medium: "Focus on application of concepts and intermediate knowledge. Include some conceptual reasoning.",
      hard: "Focus on advanced analysis, edge cases, and deep theoretical understanding. Questions should require deep thinking and logic. Distractors (wrong options) should be highly plausible and challenging."
    };

    let parsedQuiz = await callAI([{
      role: "user", content: `STRICT JSON ONLY. No markdown. No backticks. No comments.
Generate exactly ${count} MCQs on the topic "${topic}" at ${difficulty} difficulty.
Difficulty Guideline: ${difficultyInstructions[difficulty]}

Each question MUST follow this EXACT structure:
{"question": "string", "options": ["string", "string", "string", "string"], "answer": "string matching exactly one of the options"}

Return as a plain JSON array.` }], { parseJson: true });

    if (!Array.isArray(parsedQuiz) || parsedQuiz.length === 0) throw new Error("AI returned an empty quiz list.");

    parsedQuiz = parsedQuiz.map((q, idx) => {
      if (!q.question || !Array.isArray(q.options) || q.options.length < 2 || !q.answer) {
        throw new Error(`Question ${idx + 1} is missing required data.`);
      }
      return {
        question: String(q.question),
        options: q.options.map(String),
        answer: String(q.answer)
      };
    });

    clearQuizLoaderIntervals();

    Store.set({
      currentQuiz: parsedQuiz,
      currentQuizId: await storeQuizInDatabase(topic, difficulty, parsedQuiz),
      isQuizReview: false
    });

    if (!Store.state.currentQuizId) throw new Error("Database failed to save quiz metadata.");

    await startNewAttempt(Store.state.currentQuizId);
    renderQuiz();
    Store.set({ quizStartTime: Date.now() });

    window.quizLifecycle.state = "generated";
    applyButtonState();
  } catch (error) {
    console.error("Quiz Start Error:", error);
    clearQuizLoaderIntervals();
    showQuizError("❌ Generation Failed", error.message || "An unexpected error occurred.");
  } finally {
    window.isGenerating = false;
    const btn = document.getElementById("generateQuizBtn");
    if (btn) btn.textContent = "✨ Generate Quiz";
    applyButtonState();
  }
}

// ── Helper: Show loading UI with animations ──
function showQuizLoading() {
  const container = $("quiz-container");

  const loadingPhrases = [
    "🧠 Brewing brain teasers...",
    "⚡ Electrifying neurons...",
    "🔬 Distilling knowledge...",
    "🎯 Crafting challenges...",
    "✨ Sprinkling genius dust..."
  ];

  let phraseIdx = 0;

  container.innerHTML = `
    <div id="quiz-loader" style="text-align:center;padding:60px 20px;">
      <div style="font-size:48px;margin-bottom:20px;animation:spinBrain 1.5s linear infinite;display:inline-block">🧠</div>
      <div id="quiz-loader-text" style="font-size:16px;font-weight:600;color:var(--accent);margin-bottom:16px;">${loadingPhrases[0]}</div>
      <div style="width:200px;height:4px;background:rgba(255,255,255,0.07);border-radius:100px;margin:0 auto;overflow:hidden;">
        <div id="quiz-loader-bar" style="height:100%;width:0%;background:var(--accent);border-radius:100px;transition:width 0.4s ease;box-shadow:0 0 10px var(--accent)"></div>
      </div>
    </div>`;

  // Rotate phrases every 1.2 seconds
  const loaderInterval = setInterval(() => {
    phraseIdx = (phraseIdx + 1) % loadingPhrases.length;
    const t = $("quiz-loader-text");
    if (t) t.textContent = loadingPhrases[phraseIdx];
  }, 1200);

  // Animate progress bar
  let barPct = 0;
  const barInterval = setInterval(() => {
    barPct = Math.min(barPct + Math.random() * 12, 88);
    const bar = $("quiz-loader-bar");
    if (bar) bar.style.width = barPct + "%";
  }, 400);

  // Store intervals globally to clean them up if needed
  window._quizLoaderIntervals = { loaderInterval, barInterval };
}

// ── Helper: Show error UI with retry button ──
function showQuizError(title, message) {
  const container = $("quiz-container");

  container.innerHTML = `
    <div style="text-align:center;padding:60px 20px;background:rgba(255,107,107,0.08);border:1px solid rgba(255,107,107,0.2);border-radius:14px;margin-top:20px;">
      <div style="font-size:48px;margin-bottom:16px;">❌</div>
      <div style="font-size:18px;font-weight:600;color:#ff6b6b;margin-bottom:8px;">${title}</div>
      <div style="font-size:14px;color:var(--text-secondary);margin-bottom:24px;max-width:400px;margin-left:auto;margin-right:auto;">
        ${message}
      </div>
      <button class="btn-submit" onclick="startQuiz()" style="background:rgba(255,107,107,0.2);border:1px solid #ff6b6b;color:#ff6b6b;">
        🔄 Try Again
      </button>
    </div>`;
}

function showSystemMessage(text) {
  const container = document.getElementById("chatBox") || document.getElementById("chat-messages");
  if (!container) {
    // Fallback for non-chat pages: show a subtle toast
    if (typeof lbShowLiveToast === 'function') {
      lbShowLiveToast(text);
    }
    return;
  }

  const msg = document.createElement("div");
  msg.className = "chat-message system";
  msg.textContent = text;
  msg.style.cssText = "padding: 8px 12px; margin: 8px 0; background: rgba(32,210,150,0.1); color: var(--accent); border-left: 3px solid var(--accent); font-size: 13px; border-radius: 0 4px 4px 0;";

  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

function setupUIComponents() {
  // --- Sidebar Resizer ---
  const resizer = $("sidebar-resizer");
  const sidebar = document.querySelector(".sidebar");

  if (resizer && sidebar) {
    const savedWidth = localStorage.getItem("sidebar_width");
    if (savedWidth) {
      sidebar.style.width = savedWidth + "px";
      sidebar.style.flex = `0 0 ${savedWidth}px`;
    }

    let isResizing = false;
    resizer.addEventListener("mousedown", () => {
      isResizing = true;
      document.body.style.cursor = "col-resize";
    });

    document.addEventListener("mousemove", (e) => {
      if (!isResizing) return;
      const newWidth = e.clientX;
      if (newWidth > 180 && newWidth < 400) {
        sidebar.style.width = newWidth + "px";
        sidebar.style.flex = `0 0 ${newWidth}px`;
        localStorage.setItem("sidebar_width", newWidth);
      }
    });

    document.addEventListener("mouseup", () => {
      isResizing = false;
      document.body.style.cursor = "default";
    });
  }

  function updateTopicUI(topic) {
    if (!topic) return;
    const input = $("quiz-topic");
    if (input) {
      input.classList.remove("topic-animate");
      void input.offsetWidth; // force reflow
      input.classList.add("topic-animate");
      input.value = topic;
      input.dispatchEvent(new Event("input"));
      input.focus();
    } else {
      console.warn("[Random] Topic input field (#quiz-topic) not found");
    }
  }

  // --- Random Topic Button ---
  const randomTopicBtn = $("randomTopicBtn");
  if (randomTopicBtn) {
    randomTopicBtn.addEventListener("click", async () => {
      console.log("[Random] Button clicked");

      // 🛡️ State Safety: Only allow in 'idle' mode
      if (window.quizLifecycle.state !== "idle") {
        console.warn("[Random] Blocked due to state:", window.quizLifecycle.state);
        return;
      }

      const state = Store.get();
      if (state.isFetchingTopic) return;

      try {
        // 🔄 Reuse existing core logic
        const topic = await fetchRandomTopicSafe();

        if (!topic) {
          console.warn("[Random] No topic returned from fetch function");
          throw new Error("No topic generated");
        }

        console.log("[Random] Topic fetched:", topic);

        saveRecentTopics(topic);
        Store.set({ lastRandomTopic: topic });

        // 🎯 Explicit UI Update
        updateTopicUI(topic);

        showSystemMessage("Random topic generated!");
      } catch (err) {
        console.error("[Random] Error:", err);
      } finally {
        applyButtonState();
      }
    });
  }

  // 🔥 Requirement 3: Real-Time UI Feedback for Passwords
  const loginPwd = $("login-password");
  if (loginPwd) {
    loginPwd.addEventListener("input", () => {
      const val = loginPwd.value;
      if (!val) { loginPwd.style.borderColor = ""; loginPwd.style.boxShadow = ""; return; }
      const { valid } = validatePassword(val);
      loginPwd.style.borderColor = valid ? "#4ade80" : "#ff6b6b";
      loginPwd.style.boxShadow = valid ? "0 0 5px rgba(74, 222, 128, 0.2)" : "0 0 5px rgba(255, 107, 107, 0.2)";
    });
  }

  // --- Dynamic Password Validation Popup for Signup ---
  const signupPwd = $("signup-password");
  const pwdPopup = $("password-validation-popup");
  const submitBtn = $("signup-submit-btn");

  if (signupPwd && pwdPopup) {
    const reqs = [
      { id: "req-length", test: val => val.length >= 8 },
      { id: "req-upper", test: val => /[A-Z]/.test(val) },
      { id: "req-lower", test: val => /[a-z]/.test(val) },
      { id: "req-number", test: val => /\d/.test(val) },
      { id: "req-special", test: val => /[\W_]/.test(val) }
    ];

    signupPwd.addEventListener("focus", () => {
      pwdPopup.classList.add("show");
    });

    signupPwd.addEventListener("blur", () => {
      setTimeout(() => pwdPopup.classList.remove("show"), 400);
    });

    signupPwd.addEventListener("input", () => {
      const val = signupPwd.value;
      let allValid = true;

      reqs.forEach(req => {
        const el = $(req.id);
        if (el) {
          const icon = el.querySelector(".pwd-icon");
          if (req.test(val)) {
            el.classList.add("valid");
            if (icon) icon.textContent = "✓";
          } else {
            el.classList.remove("valid");
            if (icon) icon.textContent = "✕";
            allValid = false;
          }
        }
      });

      signupPwd.style.borderColor = allValid ? "#4ade80" : (val ? "#ff6b6b" : "");
      signupPwd.style.boxShadow = allValid ? "0 0 5px rgba(74, 222, 128, 0.2)" : (val ? "0 0 5px rgba(255, 107, 107, 0.2)" : "");

      if (submitBtn) {
        submitBtn.disabled = !allValid;
        submitBtn.style.opacity = allValid ? "1" : "0.5";
        submitBtn.style.cursor = allValid ? "pointer" : "not-allowed";
      }
    });
  }

  // --- Chat Draft & File Preview Restoration ---
  const chatInput = $("chat-input");
  if (chatInput) {
    // Restore drafted text
    const draft = sessionStorage.getItem('brainify_chat_draft');
    if (draft) chatInput.value = draft;

    // Save drafted text on input
    chatInput.addEventListener('input', () => {
      sessionStorage.setItem('brainify_chat_draft', chatInput.value);
    });
  }

  // Restore active file attachment pill
  if (window.currentChatFileText && window.currentChatFileName) {
    const previewContainer = $("chat-attachment-preview");
    const nameEl = $("chat-attachment-name");
    const uploadBtn = $("chat-upload-btn");
    if (nameEl) nameEl.textContent = window.currentChatFileName;
    if (previewContainer) previewContainer.style.display = "flex";
    if (uploadBtn) uploadBtn.innerHTML = "📎";
  }
}


// ── Helper: Clear any running loader intervals ──
function clearQuizLoaderIntervals() {
  if (window._quizLoaderIntervals) {
    if (window._quizLoaderIntervals.loaderInterval) {
      clearInterval(window._quizLoaderIntervals.loaderInterval);
    }
    if (window._quizLoaderIntervals.barInterval) {
      clearInterval(window._quizLoaderIntervals.barInterval);
    }
    window._quizLoaderIntervals = null;
  }
}

function clearQuizResponses(quizId, containerElement) {
  if (!containerElement) {
    console.warn("Quiz container not found");
    return;
  }

  const inputs = containerElement.querySelectorAll('.quiz-option');
  if (inputs.length === 0) {
    console.warn("No inputs to clear");
    // Even if no inputs are found in DOM, we should still clear the state if requested
  }

  if (!confirm("Do you want to clear all responses?")) return;

  try {
    // 1. Uncheck all selected inputs
    inputs.forEach(el => el.classList.remove("selected"));

    // 2. Clear stored answers
    Store.set({ userAnswers: {} });
    window.currentQuizAnswers = {};

    // 3. Clear localStorage (ONLY current quiz keys)
    if (quizId && AuthManager.user) {
      const storageKey = `quiz_draft_${AuthManager.user.id}_${quizId}`;
      localStorage.removeItem(storageKey);
    }

    // 4. Reset UI indicators
    // If progress tracking exists, it will be updated by Store subscription or next render
    console.log(`[Quiz] Cleared responses for quiz: ${quizId}`);
    console.log("Current Answers:", window.currentQuizAnswers);
  } catch (e) {
    console.error("Storage error:", e);
  }
}

function resetSubmitButtonUI() {
  const btns = [
    $("submit-quiz-btn"),
    $("pdf-submit-quiz-btn")
  ];

  btns.forEach(btn => {
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = "Submit Quiz";
    btn.style.pointerEvents = "auto";
    btn.style.opacity = "1";
    btn.style.display = "block";
  });

  window._isSubmittingQuiz = false;
}

function renderQuiz() {
  if (window.blockAutoRender) {
    console.warn("[Guard] Render blocked by blockAutoRender flag");
    return;
  }

  // 🔥 Safety Guard: Reset button UI if we are in active play mode
  if (!Store.state.isQuizReview) {
    resetSubmitButtonUI();
  }

  const quizId = String(Store.state.currentQuizId);

  // 🔥 Safe Render Guard: Allow render if context matches OR is undefined
  if (
    window.activeQuizContext &&
    window.activeQuizContext.quizId &&
    window.activeQuizContext.quizId !== quizId
  ) {
    console.warn("[Context Guard] Blocked render for inactive quiz:", quizId, "(Active:", window.activeQuizContext.quizId, ")");
    return;
  }

  const container = $("quiz-container");
  if (!container) {
    console.error("Quiz container missing: #quiz-container");
    return;
  }

  // 🔥 Guard: Do not render empty quiz container
  if (!Store.state.currentQuiz || Store.state.currentQuiz.length === 0) {
    console.warn("[Guard] Blocked render for empty quiz data");
    container.style.display = "none";
    return;
  }

  // 🔥 STEP 1: ENGAGE RENDER LOCK
  window.isRenderingQuiz = true;

  console.log("Rendering quiz:", quizId);

  container.innerHTML = "";

  // Scroll into view
  container.scrollIntoView({ behavior: "smooth", block: "start" });

  // Fallback Debug
  setTimeout(() => {
    if (container.innerHTML.trim() === "" && !window.blockAutoRender) {
      console.error("Render failed: container is empty after load for quiz:", quizId);
    }
    // 🔥 STEP 3: RELEASE RENDER LOCK
    window.isRenderingQuiz = false;
  }, 500);

  Store.state.currentQuiz.forEach((q, i) => {
    const qBlock = document.createElement("div");
    qBlock.className = "quiz-question-block";
    qBlock.innerHTML = `<div class="quiz-question-text">${i + 1}. ${q.question}</div>
      <div class="quiz-options" id="opts-${i}"></div>`;

    container.appendChild(qBlock);

    const optsEl = qBlock.querySelector(`#opts-${i}`);
    q.options.forEach((opt, oi) => {
      const btn = document.createElement("div");

      // Determine selection and review state
      const userAnswer = window.submittedQuizAnswers ? window.submittedQuizAnswers[i] : Store.state.userAnswers[i];
      const isSelected = userAnswer === opt;
      const isCorrect = String(q.answer).trim() === String(opt).trim();

      let reviewClass = "";
      const isReviewMode = Store.state.isQuizReview || window.quizLifecycle.state === "submitted";

      if (isReviewMode) {
        if (isCorrect) reviewClass = "correct";
        else if (isSelected) reviewClass = "wrong";
      }

      btn.className = `quiz-option ${isSelected ? 'selected' : ''} ${reviewClass}`;
      btn.dataset.qi = i;
      btn.dataset.opt = opt;
      btn.textContent = opt;

      if (!isReviewMode) {
        btn.onclick = () => selectAnswer(i, opt, btn);
      } else {
        btn.style.pointerEvents = "none";
        btn.classList.add("review-mode");
        // Add indicator icons for review
        if (isCorrect) {
          btn.innerHTML += ' <span class="quiz-icon">✅</span>';
        } else if (isSelected) {
          btn.innerHTML += ' <span class="quiz-icon">❌</span>';
        }
      }
      optsEl.appendChild(btn);
    });
  });

  console.log("Questions rendered:", document.querySelectorAll(".quiz-question-block").length);

  // 🔥 STEP 2: SHOW CONTAINER AFTER CONTENT INJECTED
  container.style.display = "block";
  container.style.visibility = "visible";
  container.style.opacity = "1";

  const submitBtn = $("submit-quiz-btn");
  const isSubmitted = Store.state.isQuizReview || (quizId && localStorage.getItem(`quiz_submitted_${quizId}`) === "true");

  if (submitBtn) {
    submitBtn.style.display = Store.state.isQuizReview ? "none" : "block";
  }
  applyButtonState();
}

let isSelecting = false;
async function selectAnswer(qi, ans, clickedEl) {
  if (Store.state.isQuizReview || isSelecting) return;
  isSelecting = true;

  try {
    const newAnswers = { ...Store.state.userAnswers };
    newAnswers[qi] = ans;
    Store.set({ userAnswers: newAnswers });
    window.currentQuizAnswers[qi] = ans;

    // UI Feedback
    document.querySelectorAll(`.quiz-option[data-qi="${qi}"]`).forEach(el => el.classList.remove("selected"));
    clickedEl.classList.add("selected");

    // Clear validation highlight and error message when user answers a question
    const questionBlock = clickedEl.closest('.quiz-question-block');
    if (questionBlock) {
      questionBlock.classList.remove('unanswered-highlight');
      const errEl = questionBlock.querySelector('.question-error-msg');
      if (errEl) errEl.remove();
    }

    saveQuizProgress();

    // Real-time sync to Supabase
    if (Store.state.currentAttemptId) {
      await supabaseClient?.from("user_answers").upsert({
        user_id: AuthManager.user?.id,
        attempt_id: Store.state.currentAttemptId,
        question_id: qi,
        selected_answer: ans
      }, { onConflict: 'attempt_id,question_id' });

      await supabaseClient?.from("quiz_attempts").update({
        last_question_index: qi,
        updated_at: new Date()
      }).eq("attempt_id", Store.state.currentAttemptId);
    }
  } catch (e) {
    console.warn("Select Answer Sync Error:", e);
  } finally {
    isSelecting = false;
    applyButtonState();
  }
}

async function startNewAttempt(quizId) {
  if (!AuthManager.user || !quizId) return;
  try {
    const { data: newAtt, error } = await supabaseClient?.from("quiz_attempts")
      .insert({
        user_id: AuthManager.user?.id,
        quiz_id: quizId,
        score: -1,
        status: 'in_progress',
        total_questions: Store.state.currentQuiz.length,
        last_question_index: 0
      })
      .select()
      .maybeSingle();

    if (error) throw error;
    if (newAtt) {
      Store.set({ currentAttemptId: newAtt.attempt_id });
      // Refresh sidebar to show "In Progress"
      loadPreviousQuizzes();
    }
  } catch (e) {
    console.error("Failed to start new attempt:", e);
  }
}

function saveQuizProgress() {
  try {
    if (!Store.state.currentQuizId || !AuthManager.user) return;
    const storageKey = `quiz_draft_${AuthManager.user?.id}_${Store.state.currentQuizId}`;
    safeSetStorage(storageKey, Store.state.userAnswers);
  } catch (e) { console.warn("Save progress failed:", e); }
}

function loadQuizProgress(quizId) {
  if (!AuthManager.user) return {};
  const storageKey = `quiz_draft_${AuthManager.user?.id}_${quizId}`;
  const saved = localStorage.getItem(storageKey);
  return saved ? JSON.parse(saved) : {};
}

function clearQuizProgress(quizId) {
  if (!AuthManager.user) { Router.go("page-login"); return; }
  const storageKey = `quiz_draft_${AuthManager.user?.id}_${quizId}`;
  localStorage.removeItem(storageKey);
}

// ================= QUIZ ANSWER VALIDATION =================
/**
 * Validates that all quiz questions have been answered.
 * If any are unanswered, highlights them, scrolls to the first, and shows an error banner.
 * @param {string} containerSelector - CSS selector for the quiz container (e.g. '#quiz-container' or '#pdf-quiz-container')
 * @returns {boolean} true if all questions are answered, false otherwise
 */
function validateAllQuestionsAnswered(containerSelector) {
  const totalQuestions = Store.state.currentQuiz.length;
  if (totalQuestions === 0) return false;

  const unansweredIndices = [];
  for (let i = 0; i < totalQuestions; i++) {
    if (Store.state.userAnswers[i] === undefined && window.currentQuizAnswers[i] === undefined) {
      unansweredIndices.push(i);
    }
  }

  // Clear any previous validation highlights and question-level error messages
  document.querySelectorAll('.quiz-question-block.unanswered-highlight').forEach(el => {
    el.classList.remove('unanswered-highlight');
  });
  document.querySelectorAll('.question-error-msg').forEach(el => el.remove());

  // Remove any existing validation error banners
  document.querySelectorAll('.quiz-validation-error').forEach(el => el.remove());

  if (unansweredIndices.length === 0) return true;

  // Highlight all unanswered question blocks and insert error message down to the question
  const container = document.querySelector(containerSelector);
  if (container) {
    const questionBlocks = container.querySelectorAll('.quiz-question-block');
    unansweredIndices.forEach(idx => {
      const qBlock = questionBlocks[idx];
      if (qBlock) {
        qBlock.classList.add('unanswered-highlight');

        // Create the error message element
        const errMsgDiv = document.createElement('div');
        errMsgDiv.className = 'question-error-msg';
        errMsgDiv.style.cssText = 'color: #ff6b6b; font-size: 13px; font-weight: 600; margin-top: 12px; display: flex; align-items: center; gap: 6px; animation: shake 0.5s ease;';
        errMsgDiv.innerHTML = '<span>⚠️</span> This question is required.';

        qBlock.appendChild(errMsgDiv);
      }
    });

    // Scroll to the first unanswered question
    if (questionBlocks[unansweredIndices[0]]) {
      questionBlocks[unansweredIndices[0]].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // Show inline error banner above the submit button area
  const unansweredCount = unansweredIndices.length;
  const errorMsg = `Please answer all questions before submitting the quiz. You have left ${unansweredCount} question(s) unanswered.`;

  const errorBanner = document.createElement('div');
  errorBanner.className = 'quiz-validation-error';
  errorBanner.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;padding:16px 20px;background:rgba(255,107,107,0.12);border:1px solid rgba(255,107,107,0.4);border-radius:12px;margin:16px 0;animation:shake 0.5s ease;">
      <div style="font-size:24px;flex-shrink:0;">⚠️</div>
      <div style="flex:1;">
        <div style="font-weight:600;color:#ff6b6b;font-size:14px;margin-bottom:4px;">Incomplete Quiz</div>
        <div style="font-size:13px;color:var(--text-secondary);line-height:1.5;">${errorMsg}</div>
      </div>
      <button onclick="this.closest('.quiz-validation-error').remove()" style="background:none;border:none;color:#ff6b6b;font-size:18px;cursor:pointer;padding:4px;flex-shrink:0;" title="Dismiss">✕</button>
    </div>`;

  // Insert before the submit button's parent wrapper
  if (container) {
    const submitBtnWrapper = container.parentElement?.querySelector('.button-wrapper');
    if (submitBtnWrapper) {
      submitBtnWrapper.parentElement.insertBefore(errorBanner, submitBtnWrapper);
    } else {
      container.after(errorBanner);
    }
  }

  // Auto-dismiss after 8 seconds
  setTimeout(() => {
    if (errorBanner.parentElement) errorBanner.remove();
  }, 8000);

  console.log(`[Quiz Validation] Blocked submission: ${unansweredCount} unanswered question(s)`);
  return false;
}

async function submitQuiz() {
  if (window.quizLifecycle.state !== "generated" || window._isSubmittingQuiz) return;

  const submitBtn = $("submit-quiz-btn") || $("pdf-submit-quiz-btn");
  if (!submitBtn) return;

  window._isSubmittingQuiz = true;
  try {
    // 🔒 Mandatory answer validation — block submission if any question is unanswered
    if (!validateAllQuestionsAnswered('#quiz-container')) {
      window._isSubmittingQuiz = false;
      return;
    }

    submitBtn.textContent = "🚀 Submitting...";

    // Freeze UI
    Store.set({ isQuizReview: true });
    document.querySelectorAll(".quiz-option").forEach(el => el.style.pointerEvents = "none");

    // Freeze Answers (Deep Copy)
    window.submittedQuizAnswers = JSON.parse(JSON.stringify(window.currentQuizAnswers));

    const quizPayload = Store.state.currentQuiz.map((q, i) => ({
      question: q.question,
      options: q.options,
      correct_answer: q.answer,
      user_answer: window.submittedQuizAnswers[i] || Store.state.userAnswers[i] || "Skipped"
    }));

    const prompt = `Evaluate these quiz answers. Return ONLY a valid JSON array of objects with keys: "question", "user_answer", "correct_answer", "is_correct" (boolean), "explanation".\n\nQuiz: ${JSON.stringify(quizPayload)}`;

    let results = [];
    try {
      results = await callAI([{ role: "user", content: prompt }], { parseJson: true });
    } catch (e) {
      console.warn("AI evaluation failed, using local check:", e);
      results = Store.state.currentQuiz.map((q, i) => {
        const uAns = Store.state.userAnswers[i] || "Skipped";
        return {
          question: q.question,
          user_answer: uAns,
          correct_answer: q.answer,
          is_correct: String(uAns).trim() === String(q.answer).trim(),
          explanation: `The correct answer is ${q.answer}.`
        };
      });
    }

    if (!Array.isArray(results)) throw new Error("Invalid evaluation format.");

    // Final Sync to DB
    const score = results.filter(r => r.is_correct).length;
    const startTime = Store.state.quizStartTime;
    const timeTaken = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;

    if (Store.state.currentAttemptId) {
      await supabaseClient?.from("quiz_attempts").update({
        score,
        status: 'completed',
        time_taken: timeTaken,
        updated_at: new Date()
      }).eq("attempt_id", Store.state.currentAttemptId);

      // Save each answer's correctness
      for (let i = 0; i < results.length; i++) {
        await supabaseClient?.from("user_answers").upsert({
          user_id: AuthManager.user?.id,
          attempt_id: Store.state.currentAttemptId,
          question_id: i,
          selected_answer: results[i].user_answer,
          is_correct: results[i].is_correct,
          explanation: results[i].explanation
        }, { onConflict: 'attempt_id,question_id' });
      }
    }

    // Performance Sync
    const meta = window._quizMeta || {};
    const topic = meta.topic || "Unknown";
    const topicCounts = { correct: 0, wrong: 0 };
    results.forEach(r => { if (r.is_correct) topicCounts.correct++; else topicCounts.wrong++; });

    try {
      const { data: existing } = await supabaseClient?.from("user_topic_performance").select("*")
        .eq("user_id", AuthManager.user?.id).eq("topic", topic).maybeSingle();
      if (existing) {
        await supabaseClient?.from("user_topic_performance").update({
          correct_count: existing.correct_count + topicCounts.correct,
          wrong_count: existing.wrong_count + topicCounts.wrong
        }).eq("id", existing.id);
      } else {
        await supabaseClient?.from("user_topic_performance").insert({
          user_id: AuthManager.user?.id, topic, correct_count: topicCounts.correct, wrong_count: topicCounts.wrong
        });
      }
    } catch (e) { console.warn("Performance update failed:", e); }

    clearQuizProgress(Store.state.currentQuizId);
    if (Store.state.currentQuizId) {
      localStorage.setItem(`quiz_submitted_${Store.state.currentQuizId}`, "true");
    }

    // Render result
    const att = { score, total_questions: Store.state.currentQuiz.length, created_at: new Date(), status: 'completed' };
    renderCompletedAttempt(att, results);

    if (submitBtn) submitBtn.style.display = "none";

    window.quizLifecycle.state = "submitted";
    updateDashboardLive(score, Store.state.currentQuiz.length, meta);
    updateLeaderboardScore(score, Store.state.currentQuiz.length);

    // STEP 1 & 4: Add New Quiz Button
    const resultDiv = $("quiz-result") || $("pdf-quiz-result");
    if (resultDiv) {
      const dynamicBtnId = "generate-new-quiz-btn-dynamic-" + Date.now();
      const wrap = document.createElement("div");
      wrap.style.cssText = "margin-top:24px;text-align:center;";
      wrap.innerHTML = `<button id="${dynamicBtnId}" class="btn-submit" style="width:auto;padding:12px 32px;background:rgba(32,210,150,0.1);color:var(--accent);border:1px solid var(--accent);font-weight:600;cursor:pointer;">➕ Generate New Quiz</button>`;
      resultDiv.appendChild(wrap);
      $(dynamicBtnId).addEventListener("click", resetEntireQuizEnvironment);
    }
  } catch (err) {
    console.error("Submission error:", err);
    showGlobalError("Failed to save results. Check your connection.");
  } finally {
    window._isSubmittingQuiz = false;
    if (submitBtn && submitBtn.textContent === "🚀 Submitting...") {
      submitBtn.textContent = "Submit Quiz";
    }
    applyButtonState();
  }
}

// STEP 3: Handle New Quiz Click
function generateNewQuizState() {
  if (window.quizLifecycle.state === "idle" && window.quizUIState.mode !== "new") {
    console.warn("[Guard] Cannot start new quiz: No quiz exists yet.");
    return;
  }

  // Reset ALL state
  Store.set({
    currentQuiz: [],
    currentQuizId: null,
    currentAttemptId: null,
    userAnswers: {},
    isQuizReview: false,
    quizStartTime: null
  });
  currentQuestionIndex = 0;
  window.quizLifecycle.state = "idle";

  // Clear UI
  const quizContainer = $("quiz-container");
  if (quizContainer) quizContainer.innerHTML = "";

  const quizResult = $("quiz-result");
  if (quizResult) quizResult.innerHTML = "";

  // Reset Submit Button
  const submitBtn = $("submit-quiz-btn") || $("pdf-submit-quiz-btn");
  if (submitBtn) {
    submitBtn.style.display = "none";
    submitBtn.textContent = "📤 Submit Quiz";
  }

  // Enable generate button again
  const generateBtn = $("generateQuizBtn");
  if (generateBtn) {
    generateBtn.textContent = "✨ Generate Quiz";
  }

  applyButtonState();

  // Remove new quiz button wrap
  const newBtnWrap = $("new-quiz-btn-wrap", true);
  if (newBtnWrap) newBtnWrap.remove();

  // Reset inputs
  if ($("quiz-topic")) $("quiz-topic").value = "";
  if ($("quiz-count")) $("quiz-count").value = "";
  if ($("quiz-difficulty")) $("quiz-difficulty").value = "medium";

  // Also reset file quiz inputs if they exist
  if ($("file-quiz-count")) $("file-quiz-count").value = "10";
  if ($("file-quiz-difficulty")) $("file-quiz-difficulty").value = "medium";

  toggleNewQuizButton(true);
}

// Global Aliases
window.generateNewQuizState = generateNewQuizState;
window.resetQuizUI = resetEntireQuizEnvironment;

// Scroll to top
const quizSection = $("quiz");
if (quizSection) {
  quizSection.scrollIntoView({ behavior: "smooth" });
}


// ================= QUIZ STORAGE & RETRIEVAL =================

// ── Store generated quiz in database ──
async function storeQuizInDatabase(topic, difficulty, quiz, fileData = null) {
  if (!AuthManager.user) return null;

  try {
    const payload = {
      user_id: AuthManager.user?.id,
      created_by: AuthManager.user?.id,
      topic: topic,
      difficulty: difficulty,
      question_count: quiz.length,
      questions: JSON.stringify(quiz),
      source_file_url: fileData?.url || null,
      source_file_name: fileData?.name || null,
      source_text: fileData?.text || null
    };

    const { data, error } = await supabaseClient?.from("quiz")
      .insert(payload)
      .select()
      .single();

    if (error) {
      console.warn("Primary 'quiz' table insert failed, falling back to 'quizzes':", error.message);
      const { data: qData, error: qErr } = await supabaseClient?.from("quizzes")
        .insert(payload)
        .select()
        .single();

      if (qErr) {
        console.error("Critical: Both quiz tables failed storage:", qErr);
        return null;
      }
      return qData.quiz_id;
    }

    return data.quiz_id;
  } catch (e) {
    console.error("Store quiz exception:", e);
    return null;
  }
}

// ── File Storage & UI Restoration ──

async function uploadFileToStorage(file, userId) {
  try {
    const filePath = `${userId}/${Date.now()}_${file.name}`;

    const { data, error } = await supabaseClient.storage
      .from("quiz-files")
      .upload(filePath, file);

    if (error) throw error;

    const { data: publicUrlData } = supabaseClient.storage
      .from("quiz-files")
      .getPublicUrl(filePath);

    return {
      url: publicUrlData.publicUrl,
      path: filePath
    };

  } catch (err) {
    console.error("File upload failed:", err);
    const msg = err.message || "";
    if (msg.includes("Bucket not found")) {
      throw new Error("Supabase Storage bucket 'quiz-files' not found. Please create it in your Supabase dashboard.");
    }
    if (msg.includes("row-level security policy") || msg.includes("RLS")) {
      throw new Error("Storage upload blocked by RLS policy. Please ensure the 'quiz-files' bucket allows 'INSERT' operations for authenticated users.");
    }
    throw new Error("File upload failed: " + (err.message || "Unknown error"));
  }
}

function restoreUploadedFile(fileData) {
  try {
    window.isFileUploaded = true;
    const info = document.getElementById('selected-file-info');
    const text = document.getElementById('selected-file-name');
    if (info && text) {
      info.style.display = 'block';
      text.textContent = fileData.name;
    }

    // Ensure configuration panel is visible
    const config = document.getElementById("file-quiz-config");
    if (config) config.style.display = "block";

  } catch (err) {
    console.error("Restore UI failed:", err);
  }
}

// ── Helper for robust data fetching (bypasses join errors) ──
async function fetchAttemptsWithQuizzes() {
  if (!AuthManager.user || !supabaseClient) return [];

  try {
    // 1. Fetch attempts alone
    const { data: attempts, error: attError } = await supabaseClient.from("quiz_attempts")
      .select("*")
      .eq("user_id", AuthManager.user?.id)
      .order("created_at", { ascending: false });

    if (attError) throw attError;
    if (!attempts || attempts.length === 0) return [];

    // 2. Collect unique quiz IDs
    const quizIds = [...new Set(attempts.map(a => a.quiz_id).filter(id => id))];
    if (quizIds.length === 0) return attempts.map(a => ({ ...a, quiz: null }));

    // 3. Fetch quiz details separately (trying both table names)
    let quizDetails = [];
    let { data: qData, error: qError } = await supabaseClient.from("quiz")
      .select("*")
      .in("quiz_id", quizIds);

    if (qError || !qData || qData.length === 0) {
      const res2 = await supabaseClient.from("quizzes")
        .select("*")
        .in("quiz_id", quizIds);
      if (res2 && res2.data) quizDetails = res2.data;
    } else {
      quizDetails = qData || [];
    }

    // 4. Map them together
    const quizMap = {};
    if (Array.isArray(quizDetails)) {
      quizDetails.forEach(q => {
        if (q && q.quiz_id) {
          quizMap[q.quiz_id] = q;
        }
      });
    }

    return attempts.map(a => ({
      ...a,
      quiz: quizMap[a.quiz_id] || null
    }));
  } catch (err) {
    console.error("fetchAttemptsWithQuizzes failed:", err);
    throw err;
  }
}

// ── Load history by attempts ──
async function loadPreviousQuizzes() {
  if (!AuthManager.user) { Router.go("page-login"); return; }
  try {
    const attempts = await fetchAttemptsWithQuizzes();
    Store.set({ quizzes: attempts || [] });
  } catch (e) {
    console.error("Load history exception:", e);
    renderQuizListError(e);
  }
}

function renderQuizListError(err) {
  const errMsg = err ? (err.message || String(err)) : "Check console for details.";
  const errHtml = `<div style="text-align:center;padding:32px 12px;color:#ff6b6b;font-size:12px;line-height:1.7;">
    Failed to load quiz history.<br>
    <span style="color:var(--text-muted)">${errMsg}</span>
  </div>`;
  const manualList = $("manual-quizzes-list");
  const pdfList = $("pdf-quizzes-list");
  if (manualList) manualList.innerHTML = errHtml;
  if (pdfList) pdfList.innerHTML = errHtml;

  // Hide static empty placeholders
  const manualEmpty = document.getElementById("manual-quizzes-empty");
  if (manualEmpty) manualEmpty.style.display = "none";
  const pdfEmpty = document.getElementById("pdf-quizzes-empty");
  if (pdfEmpty) pdfEmpty.style.display = "none";
}

function renderPreviousAttempts(attempts = Store.state.quizzes) {
  const manualList = $("manual-quizzes-list");
  const pdfList = $("pdf-quizzes-list");
  const dashboardRecent = $("recent-activity-list");
  const homeRecent = $("home-recent-activity");

  if (!manualList && !pdfList && !dashboardRecent && !homeRecent) return;

  const emptyHtml = `
    <div style="text-align:center;padding:48px 20px;color:var(--text-muted);">
      <div style="font-size:32px;margin-bottom:12px;">📚</div>
      <div style="font-size:14px;font-weight:500;">No quiz history found</div>
      <div style="font-size:12px;opacity:0.6;margin-top:4px;">Generate your first quiz to get started!</div>
    </div>`;

  if (!attempts || attempts.length === 0) {
    if (manualList) manualList.innerHTML = emptyHtml;
    if (pdfList) pdfList.innerHTML = emptyHtml;
    if (dashboardRecent) dashboardRecent.innerHTML = emptyHtml;
    if (homeRecent) homeRecent.innerHTML = emptyHtml;
    return;
  }

  const buildCardHtml = (att) => {
    const quiz = att.quiz || att.quizzes;
    if (!quiz) return "";
    const topic = quiz.topic || "Untitled Quiz";
    const difficulty = quiz.difficulty || "medium";
    const isCompleted = att.status === "completed" || (att.score !== undefined && att.score !== -1 && att.score !== null);
    const scoreText = isCompleted ? `${att.score}/${att.total_questions}` : "In Progress";
    const pct = isCompleted && att.total_questions > 0 ? Math.round((att.score / att.total_questions) * 100) : null;
    const dateStr = new Date(att.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

    // Dynamic styles
    const diffClass = `difficulty-${difficulty}`;
    const scoreColor = pct !== null ? (pct >= 75 ? '#4ade80' : pct >= 50 ? '#f0c040' : '#ff6b6b') : 'var(--accent)';
    const isDoc = topic.startsWith("Doc: ") || topic.startsWith("Document:");

    return `
      <div class="quiz-card ${isCompleted ? 'has-badge' : ''}" data-attempt-id="${att.attempt_id}" data-quiz-id="${quiz.quiz_id}">
        <div class="quiz-header">
          <div class="quiz-title">
            <span class="quiz-difficulty ${diffClass}">${difficulty}</span>
            ${escapeHTML(topic)}
          </div>
          ${isCompleted ? `
            <div class="score-badge" style="border-color:${scoreColor}44; color:${scoreColor}; background:${scoreColor}08">
              ${pct}%
            </div>
          ` : ""}
        </div>
        <div class="quiz-meta" style="${isCompleted ? 'padding-right: 55px;' : ''}">
          <div class="meta-item quiz-score"><span>📊</span> <b>${scoreText}</b></div>
          <div class="meta-item quiz-date"><span>📅</span> ${dateStr}</div>
          ${isDoc ? `<div class="meta-item"><span>📄</span> Document</div>` : ""}
        </div>

        <div class="quiz-actions">
          <button class="quiz-btn primary ${isCompleted ? 'view-btn' : 'resume-btn'}" data-attempt-id="${att.attempt_id}" data-quiz-id="${quiz.quiz_id}">
            ${isCompleted ? "👁 View" : "▶ Resume"}
          </button>
          ${(isDoc && quiz.source_file_url) ? `
            <button class="quiz-btn" onclick="window.open('${quiz.source_file_url}', '_blank')" style="background:rgba(32,210,150,0.1); color:var(--accent); border:1px solid var(--accent);">
              📄 Open
            </button>
          ` : ""}
          <button class="quiz-btn retake-btn" data-quiz-id="${quiz.quiz_id}" ${!isCompleted ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>
            🔁 Retake
          </button>
          <button class="quiz-btn more-btn" data-action="generate-more" data-quiz-id="${quiz.quiz_id}" ${!isCompleted ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>
            ➕ Generate More
          </button>
          <button class="quiz-btn danger delete-btn" data-attempt-id="${att.attempt_id}" data-quiz-id="${quiz.quiz_id}">
            🗑 Delete
          </button>
        </div>
      </div>`;
  };

  const emptyDefault = emptyHtml;

  // Manual Quizzes list
  if (manualList) {
    const manualAttempts = attempts.filter(att => {
      const q = att.quiz || att.quizzes;
      const t = q?.topic || "";
      return !t.startsWith("Doc: ") && !t.startsWith("Document:");
    });
    const manualHTML = manualAttempts.map(buildCardHtml).filter(Boolean).join("");
    manualList.innerHTML = manualHTML || emptyDefault;

    // Hide/show the static empty-state placeholder in HTML
    const manualEmpty = document.getElementById("manual-quizzes-empty");
    if (manualEmpty) manualEmpty.style.display = manualHTML ? "none" : "block";
  }

  // Document Quizzes list
  if (pdfList) {
    const docAttempts = attempts.filter(att => {
      const q = att.quiz || att.quizzes;
      const t = q?.topic || "";
      return t.startsWith("Doc: ") || t.startsWith("Document:");
    });
    const docHTML = docAttempts.map(buildCardHtml).filter(Boolean).join("");
    pdfList.innerHTML = docHTML || emptyDefault;

    // Hide/show the static empty-state placeholder in HTML
    const pdfEmpty = document.getElementById("pdf-quizzes-empty");
    if (pdfEmpty) pdfEmpty.style.display = docHTML ? "none" : "block";
  }

  // Dashboard / Home Recent activity
  renderRecentActivity(attempts);
}

function renderRecentActivity(attempts) {
  const dashboardRecent = $("recent-activity-list");
  const homeRecent = $("home-recent-activity");
  if (!dashboardRecent && !homeRecent) return;

  const data = (attempts || []).slice(0, 6);
  if (data.length === 0) {
    const empty = `<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px;">No recent activity yet.</div>`;
    if (dashboardRecent) dashboardRecent.innerHTML = empty;
    if (homeRecent) homeRecent.innerHTML = empty;
    return;
  }

  const html = data.map(att => {
    const quiz = att.quiz || att.quizzes;
    if (!quiz) return "";
    const topic = quiz.topic || "Untitled Quiz";
    const difficulty = quiz.difficulty || "medium";
    const isCompleted = att.status === "completed" || (att.score !== undefined && att.score !== -1 && att.score !== null);
    const scoreText = isCompleted ? `Score: ${Math.round((att.score / att.total_questions) * 100)}%` : "Status: In Progress";
    const dateStr = formatRelativeTime(new Date(att.created_at));
    const isDoc = topic.startsWith("Doc: ") || topic.startsWith("Document:");

    // Theme colors
    const color = difficulty === "hard" ? "#ff6b6b" : difficulty === "medium" ? "#f59e0b" : "var(--accent)";
    const bg = difficulty === "hard" ? "rgba(255,107,107,0.1)" : difficulty === "medium" ? "rgba(245,158,11,0.1)" : "rgba(32,210,150,0.1)";
    const icon = isDoc ? "📄" : "📝";

    return `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;padding:12px;background:${bg};border-radius:10px;border-left:4px solid ${color};cursor:pointer;transition:transform 0.2s;" onclick="loadAttempt('${att.attempt_id}')">
        <div style="font-size:18px;">${icon}</div>
        <div style="flex:1;">
          <div style="font-weight:600;color:var(--text-primary);font-size:14px;">${escapeHTML(topic)}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${scoreText} • ${dateStr}</div>
        </div>
        <div style="font-size:10px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:0.5px;">${difficulty}</div>
      </div>`;
  }).join("");

  if (dashboardRecent) dashboardRecent.innerHTML = html;
  if (homeRecent) homeRecent.innerHTML = html;
}

function formatRelativeTime(date) {
  const now = new Date();
  const diffInSeconds = Math.floor((now - date) / 1000);
  if (diffInSeconds < 60) return 'Just now';
  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return `${diffInHours}h ago`;
  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays === 1) return 'Yesterday';
  if (diffInDays < 7) return `${diffInDays}d ago`;
  return date.toLocaleDateString();
}



// ── Load a specific attempt ──
async function loadAttempt(attemptId) {
  if (!attemptId) return;
  window.quizLifecycle.state = "generated";

  // Monotonic token: each View/Resume click gets a unique token.
  // Only the LATEST click's render is allowed to execute.
  window._loadAttemptToken = (window._loadAttemptToken || 0) + 1;
  const myToken = window._loadAttemptToken;

  window.blockAutoRender = true;

  // Always force-clear all quiz containers immediately so old data never lingers
  const _forceWipeContainers = () => {
    ["#quiz-container", "#pdf-quiz-container", "#quiz-result", "#pdf-quiz-result"].forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        el.innerHTML = "";
        el.style.display = sel.includes("result") ? "none" : "";
      });
    });
  };
  _forceWipeContainers();

  try {
    // Always reset environment when loading any attempt (view OR resume)
    resetEntireQuizEnvironment();

    // 1. Fetch Attempt
    let { data: att, error: attError } = await supabaseClient?.from("quiz_attempts")
      .select("*")
      .eq("attempt_id", attemptId)
      .single();

    if (attError || !att) throw new Error("Attempt not found");

    // 2. Fetch Quiz (try both tables manually)
    let quiz = null;
    const { data: q1 } = await supabaseClient?.from("quiz").select("*").eq("quiz_id", att.quiz_id).single();
    if (q1) quiz = q1;
    else {
      const { data: q2 } = await supabaseClient?.from("quizzes").select("*").eq("quiz_id", att.quiz_id).single();
      if (q2) quiz = q2;
    }

    if (!quiz) throw new Error("Associated quiz data not found");

    // 🔥 FIX: Abort if a newer View click has already taken over
    if (myToken !== window._loadAttemptToken) {
      return;
    }

    window.activeQuizContext.quizId = String(quiz.quiz_id);
    window.activeQuizContext.mode = (att.status === "completed" || (att.score !== null && att.score !== -1)) ? "view" : "resume";

    const questions = typeof quiz.questions === 'string' ? JSON.parse(quiz.questions) : (quiz.questions || []);

    // Fetch saved answers
    const { data: ansData } = await supabaseClient?.from("user_answers")
      .select("*")
      .eq("attempt_id", attemptId)
      .order("question_id", { ascending: true });

    // Set state
    Store.state.currentQuiz = questions;
    Store.state.currentQuizId = String(quiz.quiz_id);
    Store.state.currentAttemptId = attemptId;
    Store.state.userAnswers = {};
    currentQuestionIndex = 0;
    window._quizMeta = { topic: quiz.topic, difficulty: quiz.difficulty };
    window.currentQuizAnswers = {};

    if (ansData) {
      ansData.forEach(a => {
        Store.state.userAnswers[a.question_id] = a.selected_answer;
        window.currentQuizAnswers[a.question_id] = a.selected_answer;
      });
    }

    const isDoc = quiz.topic.startsWith("Doc: ") || quiz.topic.startsWith("Document:");
    const targetPage = isDoc ? "pdf" : "quiz";

    Store.state.isQuizReview = (att.status === "completed" || (att.score !== null && att.score !== -1));
    if (Store.state.isQuizReview) window.quizLifecycle.state = "submitted";
    else window.quizLifecycle.state = "generated";

    await goTo(targetPage);

    setTimeout(() => {
      if (myToken !== window._loadAttemptToken) return;

      _forceWipeContainers();

      // Restore file UI if present (Common for View & Resume)
      if (isDoc && quiz.source_file_url) {
        restoreUploadedFile({
          url: quiz.source_file_url,
          name: quiz.source_file_name
        });
        window._currentExtractedText = quiz.source_text;
      }

      if (Store.state.isQuizReview) {
        renderCompletedAttempt(att, ansData || []);
      } else {
        currentQuestionIndex = att.last_question_index || 0;
        window.blockAutoRender = false;

        // 🔥 Fix Resume UI Desync
        resetSubmitButtonUI();
        window.quizLifecycle.state = "generated";

        if (isDoc) renderDocQuiz(); else renderQuiz();

        const submitBtnId = isDoc ? "pdf-submit-quiz-btn" : "submit-quiz-btn";
        const btn = $(submitBtnId);
        if (btn) btn.style.display = "block";

        applyButtonState();
      }
    }, 300);

  } catch (e) {
    console.error("loadAttempt failed:", e);
    alert("Failed to load quiz: " + e.message);
  } finally {
    window.blockAutoRender = false;
    applyButtonState();
  }
}

function hardResetQuizUI() {
  try {
    const selectors = [
      "#quiz-container",
      "#pdf-quiz-container",
      "#quiz-result",
      "#pdf-quiz-result"
    ];

    selectors.forEach(sel => {
      const els = document.querySelectorAll(sel);
      els.forEach(el => {
        el.innerHTML = "";
        if (sel.includes("result")) {
          el.style.display = "none";
        } else {
          el.style.display = "block";
        }
      });
    });
  } catch (err) {
    console.error("hardResetQuizUI error:", err);
  }
}

function showBlankState() {
  try {
    const isPdf = $("pdf") && $("pdf").classList.contains("active");
    const container = isPdf ? $("pdf-quiz-container") : $("quiz-container");

    if (container) {
      container.style.display = "block";
      container.innerHTML = `
        <div class="blank-state" style="text-align:center;padding:60px 20px;color:var(--text-muted);border:2px dashed var(--border);border-radius:16px;margin-top:20px;background:rgba(255,255,255,0.02);">
          <div style="font-size:32px;margin-bottom:12px;">📝</div>
          <p style="font-size:16px;font-weight:500;">Select options and click "Generate Quiz"</p>
          <p style="font-size:13px;opacity:0.7;margin-top:8px;">Ready to brew something fresh?</p>
        </div>
      `;
    }
  } catch (err) {
    console.error("Blank state error:", err);
  }
}


async function generateMoreFromQuiz(quizId) {
  if (!quizId) return;

  try {
    // 1. Fetch original quiz details
    let quiz = null;
    const { data: q1 } = await supabaseClient?.from("quiz").select("*").eq("quiz_id", quizId).maybeSingle();
    if (q1) quiz = q1;
    else {
      const { data: q2 } = await supabaseClient?.from("quizzes").select("*").eq("quiz_id", quizId).maybeSingle();
      if (q2) quiz = q2;
    }

    if (!quiz) throw new Error("Original quiz not found");

    // 2. Identify if it's a Document Quiz
    const isDoc = quiz.topic.startsWith("Doc: ") || quiz.topic.startsWith("Document:");
    await goTo(isDoc ? "pdf" : "quiz");

    // 3. Pre-fill Inputs
    const qCount = quiz.question_count || 10;
    if (isDoc) {
      if ($("file-quiz-count")) $("file-quiz-count").value = qCount;
      if ($("file-quiz-difficulty")) $("file-quiz-difficulty").value = quiz.difficulty;

      const config = $("file-quiz-config");
      if (config) config.style.display = "block";
    } else {
      if ($("quiz-topic")) $("quiz-topic").value = quiz.topic;
      if ($("quiz-count")) $("quiz-count").value = qCount;
      if ($("quiz-difficulty")) $("quiz-difficulty").value = quiz.difficulty;
    }

    // 4. RESET Environment (Clears UI & Sets state to 'idle')
    resetEntireQuizEnvironment();

    // Restore file UI if it's a doc quiz
    if (isDoc && quiz.source_file_url) {
      restoreUploadedFile({
        url: quiz.source_file_url,
        name: quiz.source_file_name
      });
      window._currentExtractedText = quiz.source_text;
    }

    // 5. Scroll to inputs for better UX
    window.scrollTo({ top: 0, behavior: "smooth" });

    console.log("[Generate More] Inputs pre-filled, waiting for user response.");
  } catch (e) {
    console.error("Generate More (Pre-fill) error:", e);
    showSystemMessage("Failed to load quiz settings: " + e.message);
  }
}

window.generateMoreFromQuiz = generateMoreFromQuiz;
window.retakeQuiz = retakeQuiz;
window.loadAttempt = loadAttempt;
window.deleteAttempt = deleteAttempt;
window.deleteQuiz = deleteAttempt;

async function generateMoreQuestions(quizId) {
  const isPdfView = $("pdf") && $("pdf").classList.contains("active");
  const meta = isPdfView ? window._docQuizMeta : window._quizMeta;

  const topic = (isPdfView ? "" : $("quiz-topic")?.value) || meta?.topic || "Current Topic";
  const difficulty = (isPdfView ? $("file-quiz-difficulty")?.value : $("quiz-difficulty")?.value) || meta?.difficulty || "medium";
  const count = (isPdfView ? $("file-quiz-count")?.value : $("quiz-count")?.value) || 5;

  // 🔒 Question count limit validation
  const numCount = parseInt(count, 10);
  if (!isNaN(numCount) && numCount > MAX_QUIZ_QUESTIONS) {
    const errorFn = isPdfView ? showDocQuizError : showQuizError;
    if (typeof errorFn === 'function') {
      errorFn("⚠️ Question Limit Exceeded", QUESTION_LIMIT_ERROR_MSG);
    } else {
      alert(QUESTION_LIMIT_ERROR_MSG);
    }
    return;
  }

  const btn = isPdfView ? $("pdf-generate-more-btn") : $("generate-more-btn");
  const originalText = btn ? btn.textContent : "";
  if (btn) { btn.textContent = "⏳ Brewing More..."; }

  try {
    const difficultyInstructions = {
      easy: "Focus on basic concepts.",
      medium: "Focus on application.",
      hard: "Focus on advanced analysis and edge cases. Make it challenging."
    };

    const existingQuestions = Store.state.currentQuiz.map(q => q.question).slice(-10);

    const newQuestions = await callAI([{
      role: "user",
      content: `STRICT JSON ONLY. No markdown.
Generate ${count} MORE ${difficulty} MCQs on topic "${topic}".
DO NOT repeat these questions: ${JSON.stringify(existingQuestions)}
Difficulty Guideline: ${difficultyInstructions[difficulty]}

Format: [{"question":"","options":["","","",""],"answer":""}]`
    }], { parseJson: true });

    if (Array.isArray(newQuestions)) {
      const combined = [...Store.state.currentQuiz, ...newQuestions];
      Store.set({ currentQuiz: combined, isQuizReview: false });

      if (Store.state.currentQuizId) {
        await supabaseClient?.from("quiz").update({
          questions: JSON.stringify(combined),
          question_count: combined.length
        }).eq("quiz_id", Store.state.currentQuizId);
      }

      if (isPdfView) {
        if ($("pdf-quiz-result")) $("pdf-quiz-result").innerHTML = "";
        if ($("pdf-submit-quiz-btn")) $("pdf-submit-quiz-btn").style.display = "block";
        renderDocQuiz();
      } else {
        if ($("quiz-result")) $("quiz-result").innerHTML = "";
        if ($("submit-quiz-btn")) $("submit-quiz-btn").style.display = "block";
        renderQuiz();
      }
    }
  } catch (e) {
    console.error("Generate more failed:", e);
    alert("Failed to generate more questions.");
  } finally {
    if (btn) { btn.textContent = originalText; }
    applyButtonState();
  }
}
window.generateMoreQuestions = generateMoreQuestions;

async function deleteAttempt(quizId, attemptId) {
  if (!confirm("Are you sure you want to delete this quiz attempt? This cannot be undone.")) return;

  try {
    if (attemptId) {
      const { error } = await supabaseClient?.from("quiz_attempts").delete().eq("attempt_id", attemptId);
      if (error) throw error;
    } else if (quizId) {
      await supabaseClient?.from("quiz").delete().eq("quiz_id", quizId);
      await supabaseClient?.from("quizzes").delete().eq("quiz_id", quizId);
    }

    await loadPreviousQuizzes();
    await loadHomeDashboard();

    if (Store.state.currentAttemptId === String(attemptId)) {
      resetQuizState();
      goTo("home");
    }
  } catch (e) {
    console.error("Delete attempt failed:", e);
    alert("Could not delete from history.");
  }
}

async function retakeQuiz(quizId) {
  if (window.isGenerating) return;
  quizId = quizId || Store.state.currentQuizId;
  if (!AuthManager.user || !quizId) return;

  if (!confirm("Start a fresh attempt for this quiz? Your old answers for this attempt won't be shown, but your history will be saved.")) return;

  try {
    window.isGenerating = true;
    resetEntireQuizEnvironment();

    window.activeQuizContext.quizId = String(quizId);
    window.activeQuizContext.mode = "retake";

    resetQuizState();
    window.scrollTo({ top: 0, behavior: "smooth" });

    let quiz = null;
    const { data: q1 } = await supabaseClient?.from("quiz").select("*").eq("quiz_id", quizId).maybeSingle();
    if (q1) quiz = q1;
    else {
      const { data: q2 } = await supabaseClient?.from("quizzes").select("*").eq("quiz_id", quizId).maybeSingle();
      if (q2) quiz = q2;
    }

    if (!quiz) throw new Error("Quiz not found in database.");

    const isDoc = quiz.topic.startsWith("Doc: ") || quiz.topic.startsWith("Document:");

    Store.set({
      currentQuiz: typeof quiz.questions === "string" ? JSON.parse(quiz.questions) : quiz.questions,
      currentQuizId: String(quiz.quiz_id),
      isQuizReview: false
    });

    await goTo(isDoc ? "pdf" : "quiz");

    // Restore file UI if it's a doc quiz
    if (isDoc && quiz.source_file_url) {
      restoreUploadedFile({
        url: quiz.source_file_url,
        name: quiz.source_file_name
      });
      window._currentExtractedText = quiz.source_text;
    }

    const containers = ["quiz-result", "pdf-quiz-result", "quiz-container", "pdf-quiz-container"];
    containers.forEach(id => { const el = $(id); if (el) el.innerHTML = ""; });

    await startNewAttempt(Store.state.currentQuizId);

    resetSubmitButtonUI();
    if (isDoc) renderDocQuiz(); else renderQuiz();
    Store.set({ quizStartTime: Date.now() });

    window.quizLifecycle.state = "generated";
    applyButtonState();
  } catch (e) {
    console.error("Retake Failed:", e);
    showSystemMessage("Could not restart quiz: " + e.message);
  } finally {
    window.isGenerating = false;
    applyButtonState();
  }
}

function renderCompletedAttempt(att, answers) {
  Store.set({ isQuizReview: true });
  const isPdfView = $("pdf").classList.contains("active");
  const container = isPdfView ? $("pdf-quiz-container") : $("quiz-container");
  if (!container) return;
  const resultContainer = isPdfView ? $("pdf-quiz-result") : $("quiz-result");
  const submitBtn = isPdfView ? $("pdf-submit-quiz-btn") : $("submit-quiz-btn");

  if (container) {
    // Keep container visible in review mode
    container.style.display = "block";
    // Render the quiz questions with highlights
    if (isPdfView) renderDocQuiz(); else renderQuiz();
  }
  if (resultContainer) {
    resultContainer.innerHTML = "";
    resultContainer.style.display = "block";
  }
  if (submitBtn) submitBtn.style.display = "none";

  const clearBtn = document.querySelector(".clear-responses-btn");
  if (clearBtn) {
    clearBtn.style.display = "none";
  }

  const enrichedResults = Store.state.currentQuiz.map((q, i) => {
    let ans = answers.find(a => a.question_id == i) || answers[i];
    let uAns = "Not answered";

    if (ans && (ans.selected_answer || ans.user_answer)) {
      uAns = ans.selected_answer || ans.user_answer;
    } else if (window.submittedQuizAnswers && window.submittedQuizAnswers[i] !== undefined) {
      uAns = window.submittedQuizAnswers[i];
    } else if (Store.state.userAnswers[i] !== undefined) {
      uAns = Store.state.userAnswers[i];
    }

    return {
      question: q.question,
      user_answer: uAns,
      correct_answer: q.answer,
      is_correct: ans ? (ans.is_correct ?? (String(uAns).trim() === String(q.answer).trim())) : (String(uAns).trim() === String(q.answer).trim()),
      explanation: (ans && ans.explanation) ? ans.explanation : `The correct answer is ${q.answer}.`
    };
  });

  renderCompletedAttemptWithContainer(resultContainer, att, enrichedResults);
  if (resultContainer) resultContainer.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderCompletedAttemptWithContainer(container, att, results) {
  if (!container) return;
  container.innerHTML = "";

  const score = att.score;
  const total = att.total_questions;
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;

  let grade, color, emoji, msg;
  if (pct >= 90) { grade = "S"; msg = "Outstanding! You crushed it!"; color = "#20D296"; emoji = "🏆"; }
  else if (pct >= 75) { grade = "A"; msg = "Great job! Almost perfect!"; color = "#4ade80"; emoji = "🎉"; }
  else if (pct >= 60) { grade = "B"; msg = "Good work! Keep pushing!"; color = "#60a5fa"; emoji = "👍"; }
  else if (pct >= 40) { grade = "C"; msg = "Not bad, but there's room to grow."; color = "#f0c040"; emoji = "📚"; }
  else { grade = "D"; msg = "Keep practicing, you'll get there!"; color = "#ff6b6b"; emoji = "💪"; }

  const quizMeta = att.quiz || att.quizzes || window._quizMeta || {};
  const topic = quizMeta.topic || "Quiz Result";
  const difficulty = quizMeta.difficulty || "";
  const date = new Date(att.created_at || Date.now()).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  const breakdown = results.map((r, i) => {
    const icon = r.is_correct ? "✅" : "❌";
    const ansColor = r.is_correct ? "#20D296" : "#ff6b6b";
    const qText = r.question || r.questions || `Question ${i + 1}`;
    const uAns = r.user_answer || r.selected_answer || "Not answered";
    const cAns = r.correct_answer || r.answer || "Unknown";

    return `
      <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;margin-bottom:12px;">
        <div style="font-size:14px;font-weight:600;margin-bottom:8px;color:var(--text-primary);">${icon} Q${i + 1}. ${escapeHTML(qText)}</div>
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:4px;">
          Your answer: <span style="color:${ansColor};font-weight:600">${escapeHTML(uAns)}</span>
        </div>
        ${!r.is_correct ? `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:4px;">
          Correct: <span style="color:#20D296;font-weight:600">${escapeHTML(cAns)}</span>
        </div>` : ""}
        <div style="font-size:12px;color:var(--text-muted);font-style:italic;margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.05);">
          💡 ${escapeHTML(r.explanation || "No explanation available.")}
        </div>
      </div>`;
  }).join("");

  container.innerHTML = `
    <div class="score-card" style="margin-bottom:28px;">
      <div style="display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:20px;opacity:0.8;">
         ${difficulty ? `<span style="background:rgba(255,255,255,0.08);padding:3px 10px;border-radius:100px;font-size:10px;font-weight:700;color:var(--text-muted);border:1px solid rgba(255,255,255,0.1);">${difficulty.toUpperCase()}</span>` : ""}
         <span style="font-size:12px;color:var(--text-muted);">${escapeHTML(topic)}</span>
         <span style="font-size:11px;color:var(--text-muted);opacity:0.5;">• ${date}</span>
      </div>
      <div class="score-emoji">${emoji}</div>
      <div class="score-grade" style="color:${color}">${grade}</div>
      <div class="score-numbers">${score} / ${total}</div>
      <div class="score-pct-bar-wrap">
        <div class="score-pct-bar" style="width:${pct}%;background:${color};box-shadow:0 0 15px ${color}88"></div>
      </div>
      <div class="score-pct-label" style="color:${color}">${pct}% Accuracy</div>
      <div class="score-msg">${msg}</div>
    </div>
    
    <div style="margin-top:32px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 style="font-size:16px;font-weight:600;margin:0;">📋 Answer Breakdown</h3>
        <span style="font-size:12px;color:var(--text-muted);">${results.filter(r => r.is_correct).length} Correct</span>
      </div>
      ${breakdown}
    </div>
  `;

  container.style.display = "block";
  container.style.visibility = "visible";
  container.style.opacity = "1";
}

async function showQuizQuestions(quizId) {
  const { quizzes } = Store.get();
  const quiz = quizzes.find(q => String(q.quiz_id) == String(quizId));
  if (!quiz) return;

  window.blockAutoRender = false;
  Store.set({ currentQuiz: typeof quiz.questions === 'string' ? JSON.parse(quiz.questions) : quiz.questions });
  renderQuiz();

  const { data: attempts } = await supabaseClient?.from("quiz_attempts")
    .select("attempt_id")
    .eq("quiz_id", quizId)
    .eq("user_id", AuthManager.user?.id)
    .order("created_at", { ascending: false })
    .limit(1);

  if (attempts && attempts.length > 0) {
    const { data: answers } = await supabaseClient?.from("user_answers")
      .select("*")
      .eq("attempt_id", attempts[0].attempt_id);

    if (answers) {
      answers.forEach((ans, i) => {
        const opts = document.querySelectorAll(`.quiz-option[data-qi="${i}"]`);
        opts.forEach(optEl => {
          const optText = optEl.dataset.opt;
          if (optText === Store.state.currentQuiz[i].answer) {
            optEl.classList.add("correct");
          } else if (!ans.is_correct && optText === ans.selected_answer) {
            optEl.classList.add("wrong");
          }
          if (optText === ans.selected_answer) {
            optEl.classList.add("selected");
          }
        });
      });
    }
  }

  document.querySelectorAll(".quiz-option").forEach(el => el.style.pointerEvents = "none");
  $("submit-quiz-btn").style.display = "none";
  $("pdf-submit-quiz-btn").style.display = "none";
};

let lbCachedLeaderboard = null;
let lbIsLoading = false;
let lbRealtimeChannel = null;
let lbPollingInterval = null;

async function updateLeaderboardScore(score, totalQs) {
  if (!AuthManager.user || !supabaseClient) return;

  try {
    const normalizedScore = Math.max(0, score);
    const startTime = Store.state.quizStartTime;
    const completionTime = startTime ? Math.round((Date.now() - startTime) / 1000) : 999999;

    // 🔥 PERSISTENCE CHECK: Fetch existing record to ensure we only update if it's a NEW HIGH SCORE
    const { data: existing, error: fetchErr } = await supabaseClient
      .from('leaderboard')
      .select('score, completion_time')
      .eq('user_id', AuthManager.user.id)
      .maybeSingle();

    if (fetchErr) console.warn("Could not fetch existing leaderboard record:", fetchErr);

    let shouldUpdate = !existing;
    if (existing) {
      // Logic: Update if score is higher OR if score is same but time is faster
      if (normalizedScore > existing.score) {
        shouldUpdate = true;
      } else if (normalizedScore === existing.score && completionTime < (existing.completion_time || 999999)) {
        shouldUpdate = true;
      }
    }

    if (!shouldUpdate) {
      console.log("[Leaderboard] Current attempt is not better than personal best. Skipping update.");
      return;
    }

    const username = AuthManager.user?.user_metadata?.username ||
      AuthManager.user?.user_metadata?.full_name ||
      "Brainify User";

    const { error } = await supabaseClient
      .from('leaderboard')
      .upsert({
        user_id: AuthManager.user.id,
        username: (username || "Brainify User").trim(),
        score: normalizedScore,
        completion_time: completionTime,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });

    if (error) throw error;
    fetchAndRenderLeaderboard(true);
  } catch (err) {
    console.error("Leaderboard update failed:", err);
  }
}

async function fetchAndRenderLeaderboard(isSilent = false) {
  if (lbIsLoading && !isSilent) return;
  const tbody = $("leaderboard-table-body");
  if (!tbody) return;

  lbIsLoading = true;
  if (!isSilent) lbShowSkeleton();

  try {
    // Rule 1: SHOW ONLY TOP 10 USERS
    // Rule 1b: Sort by highest score, then fastest time, then earliest timestamp
    const { data, error } = await supabaseClient
      .from('leaderboard')
      .select('*')
      .order('score', { ascending: false })
      .order('completion_time', { ascending: true })
      .order('updated_at', { ascending: true })
      .limit(10);

    if (error) throw error;
    lbCachedLeaderboard = data;
    lbRenderPodium(data);
    lbRenderTable(data, isSilent);

    if (isSilent) lbShowLiveToast("Rankings updated live");
  } catch (err) {
    console.error("Leaderboard fetch error:", err);
    if (!isSilent) tbody.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted);">Failed to load rankings.</div>`;
  } finally {
    lbIsLoading = false;
  }
}

function lbShowSkeleton() {
  const tbody = $("leaderboard-table-body");
  if (!tbody) return;
  tbody.innerHTML = Array(5).fill(0).map(() => `
    <div style="display:grid;grid-template-columns:56px 1fr 110px 90px 80px;padding:14px 24px;border-bottom:1px solid var(--border);">
      <div class="lb-skeleton" style="width:20px;height:14px;"></div>
      <div class="lb-skeleton" style="width:100px;height:14px;"></div>
      <div class="lb-skeleton" style="width:40px;height:14px;"></div>
      <div class="lb-skeleton" style="width:40px;height:14px;"></div>
      <div class="lb-skeleton" style="width:30px;height:14px;"></div>
    </div>`).join('');
}

function lbRenderPodium(data) {
  const top3 = data || [];
  const slots = [
    { id: '1st', user: top3[0] },
    { id: '2nd', user: top3[1] },
    { id: '3rd', user: top3[2] }
  ];

  slots.forEach(s => {
    const nameEl = $(`lb-${s.id}-name`);
    const scoreEl = $(`lb-${s.id}-score`);
    if (nameEl) nameEl.textContent = s.user ? (s.user.username || "Brainify User") : "---";
    if (scoreEl) scoreEl.textContent = s.user ? `${s.user.score} pts` : "0 pts";
  });
}

function lbRenderTable(data, flash = false) {
  const tbody = $("leaderboard-table-body");
  if (!tbody) return;

  if (!data || data.length === 0) {
    tbody.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted);">No rankings yet — be the first! 🚀</div>`;
    return;
  }

  tbody.innerHTML = data.map((user, idx) => {
    const rank = idx + 1;
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
    const name = user.username || "Brainify User";
    const rowBg = idx % 2 === 0 ? 'rgba(255,255,255,0.01)' : 'transparent';
    const isSelf = AuthManager.user && user.user_id === AuthManager.user.id;
    const dateStr = new Date(user.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

    return `
    <div class="lb-table-row ${flash ? 'lb-updated-flash' : ''}" 
         style="display:grid;grid-template-columns:56px 1fr 110px 90px 80px;align-items:center;padding:14px 24px;border-bottom:1px solid var(--border);background:${isSelf ? 'rgba(32,210,150,0.08)' : rowBg};">
      <div>
        <span class="lb-rank-badge" style="background:rgba(255,255,255,0.04);border:1px solid var(--border);color:var(--text-secondary);">
          ${medal || ('#' + rank)}
        </span>
      </div>
      <div style="font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${isSelf ? 'color:var(--accent);' : ''}">${lbEscHTML(name)}</div>
      <div style="font-weight:700;color:var(--accent);font-size:15px;">${user.score} <span style="font-size:10px; opacity:0.6; font-weight:400;">pts</span></div>
      <div style="font-size:13px;color:var(--text-secondary);">${user.completion_time}s</div>
      <div style="color:var(--text-muted);font-size:11px;">${dateStr}</div>
    </div>`;
  }).join('');
}

function lbEscHTML(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function lbShowLiveToast(message) {
  let toast = $('lb-toast', true);
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'lb-toast';
    toast.style.cssText = `position:fixed;bottom:28px;right:28px;z-index:999;background:rgba(10,14,30,0.95);border:1px solid var(--accent-glow);border-radius:12px;padding:12px 20px;font-size:13px;color:var(--accent);backdrop-filter:blur(16px);display:flex;align-items:center;gap:9px;transition:all 0.4s;opacity:0;transform:translateY(20px);`;
    document.body.appendChild(toast);
  }
  toast.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 6px var(--accent);"></span> ${message}`;
  toast.style.opacity = '1';
  toast.style.transform = 'translateY(0)';
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(10px)'; }, 3000);
}

function setupLeaderboardRealtime() {
  if (lbRealtimeChannel) supabaseClient.removeChannel(lbRealtimeChannel);
  lbRealtimeChannel = supabaseClient.channel('lb-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'leaderboard' }, () => fetchAndRenderLeaderboard(true))
    .subscribe();
}

function initLeaderboardSystem() {
  if (!lbPollingInterval) {
    setupLeaderboardRealtime();
    lbPollingInterval = setInterval(() => fetchAndRenderLeaderboard(true), 60000);
  }
  fetchAndRenderLeaderboard();
}

async function loadLeaderboard() {
  initLeaderboardSystem();
}

async function deletePreviousQuiz(quizId) {
  if (!confirm("Delete this quiz? Previous attempts will remain in your history.")) return;

  try {
    const { error } = await supabaseClient?.from("quizzes")
      .delete()
      .eq("quiz_id", quizId);

    if (error) {
      console.error("Delete quiz error:", error);
      return;
    }

    Store.set({ quizzes: Store.state.quizzes.filter(q => q.quiz_id !== quizId) });
    renderPreviousQuizzes(Store.state.quizzes);

    if (Store.state.currentQuizId === quizId) {
      Store.state.currentQuiz = [];
      Store.state.currentQuizId = null;
      Store.state.userAnswers = {};
      $("quiz-container").innerHTML = "";
      $("quiz-result").innerHTML = "";
    }
  } catch (e) {
    console.error("Delete quiz exception:", e);
  }
}

async function updateDashboardLive(newScore, newTotal, meta) {
  if (!AuthManager.user) { Router.go("page-login"); return; }
  try {
    const data = await fetchAttemptsWithQuizzes();
    const sortedData = [...data].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    if (!sortedData || sortedData.length === 0) return;
    const completed = sortedData.filter(d => d.status === 'completed' && d.score !== null && d.score !== -1);
    if (completed.length === 0) return;

    let totalScore = 0, totalQuestions = 0, best = 0;
    let topicMap = {};

    completed.forEach(d => {
      totalScore += d.score;
      totalQuestions += d.total_questions;
      if (d.score > best) best = d.score;
      const topic = d.quiz?.topic || "Unknown";
      topicMap[topic] = (topicMap[topic] || 0) + 1;
    });

    const total = completed.length;
    const avg = (totalScore / total).toFixed(1);
    const accuracy = ((totalScore / totalQuestions) * 100).toFixed(1);
    const streak = computeStreak(completed);
    const uniqueTopics = Object.keys(topicMap).length;

    animateStat("stat-total", total);
    animateStat("stat-avg", avg);
    animateStat("stat-best", best);
    $("stat-accuracy").textContent = accuracy + "%";
    $("stat-streak").textContent = streak + " 🔥";
    animateStat("stat-topics", uniqueTopics);

    loadDashboard();
  } catch (e) {
    console.error("Update dashboard live error:", e);
  }
}

function animateStat(id, newVal) {
  const el = $(id);
  if (!el) return;
  el.style.transform = "scale(1.2)";
  el.style.color = "var(--accent)";
  el.textContent = newVal;
  setTimeout(() => {
    el.style.transform = "scale(1)";
    el.style.color = "";
  }, 400);
}

// ================= DASHBOARD =================
async function loadDashboard(providedData = null) {
  try {
    const data = providedData || await fetchAttemptsWithQuizzes();
    if (!providedData) Store.set({ quizzes: data || [] });
    const sortedData = [...data].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const togglePlaceholders = (show) => {
      ['scoreChart', 'accuracyChart', 'difficultyChart', 'topicChart'].forEach(id => {
        const c = $(id);
        const p = $(id + '-placeholder');
        if (c) c.style.display = show ? 'none' : 'block';
        if (p) p.style.display = show ? 'block' : 'none';
      });
    };

    if (!sortedData || sortedData.length === 0) {
      ["stat-total", "stat-avg", "stat-best", "stat-accuracy", "stat-streak", "stat-topics"]
        .forEach(id => { const el = $(id); if (el) el.textContent = id === "stat-accuracy" ? "0%" : "0"; });
      const actList = $("recent-activity-list");
      if (actList) actList.innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:14px;">No quizzes taken yet. Go to Quiz to get started! 🧠</div>`;
      [scoreChartInstance, difficultyChartInstance, topicChartInstance, accuracyChartInstance].forEach(c => { if (c) c.destroy(); });
      scoreChartInstance = difficultyChartInstance = topicChartInstance = accuracyChartInstance = null;
      togglePlaceholders(true);
      return;
    }

    renderRecentActivity(data);

    const completed = sortedData.filter(d => d.status === 'completed' && d.score !== null && d.score !== -1);
    if (completed.length === 0) {
      ["stat-total", "stat-avg", "stat-best", "stat-accuracy", "stat-streak", "stat-topics"]
        .forEach(id => { const el = $(id); if (el) el.textContent = id === "stat-accuracy" ? "0%" : "0"; });

      [scoreChartInstance, difficultyChartInstance, topicChartInstance, accuracyChartInstance].forEach(c => { if (c) c.destroy(); });
      scoreChartInstance = difficultyChartInstance = topicChartInstance = accuracyChartInstance = null;
      togglePlaceholders(true);
      return;
    }

    togglePlaceholders(false);

    let total = completed.length, totalScore = 0, totalQuestions = 0, best = 0;
    let labels = [], scores = [], accuracies = [];
    let diffMap = { easy: 0, medium: 0, hard: 0 };
    let topicMap = {};

    completed.forEach(d => {
      totalScore += d.score;
      totalQuestions += d.total_questions;
      if (d.score > best) best = d.score;
      labels.push(new Date(d.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }));
      scores.push(d.score);
      accuracies.push(Math.round((d.score / d.total_questions) * 100));
      const diff = (d.quiz?.difficulty || "medium").toLowerCase();
      if (diffMap[diff] !== undefined) diffMap[diff]++; else diffMap["medium"]++;

      const topic = d.quiz?.topic || "Unknown";
      if (!topicMap[topic]) topicMap[topic] = { topic: topic, correct_count: 0, wrong_count: 0, total: 0 };
      topicMap[topic].correct_count += d.score;
      topicMap[topic].wrong_count += (d.total_questions - d.score);
      topicMap[topic].total += 1;
    });

    const avg = (totalScore / total).toFixed(1);
    const accuracy = ((totalScore / totalQuestions) * 100).toFixed(1);
    const streak = computeStreak(completed);
    const totalTime = completed.reduce((acc, d) => acc + (d.time_taken || 0), 0);
    const totalTimeMinutes = Math.round(totalTime / 60);

    const topicPerf = Object.values(topicMap);
    const uniqueTopics = topicPerf.length;

    const dashMap = {
      "stat-total": total,
      "stat-avg": avg,
      "stat-best": best,
      "stat-accuracy": accuracy + "%",
      "stat-streak": streak + " 🔥",
      "stat-topics": uniqueTopics
    };
    Object.entries(dashMap).forEach(([id, val]) => {
      const el = $(id);
      if (el) el.textContent = val;
    });

    const homeMap = {
      "home-stat-total": total,
      "home-stat-avg": avg,
      "home-stat-best": best,
      "home-stat-accuracy": accuracy + "%",
      "home-stat-time": totalTimeMinutes < 60 ? totalTimeMinutes + "m" : (totalTimeMinutes / 60).toFixed(1) + "h"
    };
    Object.entries(homeMap).forEach(([id, val]) => {
      const el = $(id);
      if (el) el.textContent = val;
    });

    renderTopicMastery(topicPerf);

    const homeChartCanvas = $("homeScoreChart");
    const homeChartPlaceholder = $("homeChart-placeholder");
    if (completed.length >= 3) {
      if (homeChartCanvas) homeChartCanvas.style.display = 'block';
      if (homeChartPlaceholder) homeChartPlaceholder.style.display = 'none';
      if (homeChartCanvas) renderHomeScoreChart(completed);
    } else {
      if (homeChartCanvas) homeChartCanvas.style.display = 'none';
      if (homeChartPlaceholder) homeChartPlaceholder.style.display = 'block';
    }

    const chartDefaults = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#F0F4FF", font: { family: "Outfit" } } } },
      scales: {
        x: { ticks: { color: "rgba(240,244,255,0.5)" }, grid: { color: "rgba(255,255,255,0.05)" } },
        y: { ticks: { color: "rgba(240,244,255,0.5)" }, grid: { color: "rgba(255,255,255,0.05)" }, beginAtZero: true }
      }
    };

    const ctx1 = $("scoreChart").getContext("2d");
    if (scoreChartInstance) scoreChartInstance.destroy();
    scoreChartInstance = new Chart(ctx1, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Score",
          data: scores,
          borderColor: "#20D296",
          backgroundColor: (context) => {
            const chart = context.chart;
            const { ctx, chartArea } = chart;
            if (!chartArea) return null;
            const gradient = ctx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
            gradient.addColorStop(0, "rgba(32,210,150,0)");
            gradient.addColorStop(1, "rgba(32,210,150,0.25)");
            return gradient;
          },
          borderWidth: 3.5,
          tension: 0.45,
          pointBackgroundColor: "#20D296",
          pointBorderColor: "rgba(255,255,255,0.2)",
          pointBorderWidth: 2,
          pointRadius: 6,
          pointHoverRadius: 8,
          fill: true
        }]
      },
      options: {
        ...chartDefaults,
        plugins: { ...chartDefaults.plugins, legend: { display: false } },
        scales: {
          x: { ...chartDefaults.scales.x, grid: { display: false } },
          y: { ...chartDefaults.scales.y, grid: { color: "rgba(255,255,255,0.03)" } }
        }
      }
    });

    const ctx4 = $("accuracyChart") && $("accuracyChart").getContext("2d");
    if (ctx4) {
      if (accuracyChartInstance) accuracyChartInstance.destroy();
      accuracyChartInstance = new Chart(ctx4, {
        type: "line",
        data: {
          labels,
          datasets: [{
            label: "Accuracy %",
            data: accuracies,
            borderColor: "#60a5fa",
            backgroundColor: (context) => {
              const chart = context.chart;
              const { ctx, chartArea } = chart;
              if (!chartArea) return null;
              const gradient = ctx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
              gradient.addColorStop(0, "rgba(96,165,250,0)");
              gradient.addColorStop(1, "rgba(96,165,250,0.25)");
              return gradient;
            },
            borderWidth: 3.5,
            tension: 0.45,
            pointBackgroundColor: "#60a5fa",
            pointBorderColor: "rgba(255,255,255,0.2)",
            pointBorderWidth: 2,
            pointRadius: 6,
            pointHoverRadius: 8,
            fill: true
          }]
        },
        options: {
          ...chartDefaults,
          plugins: { ...chartDefaults.plugins, legend: { display: false } },
          scales: {
            x: { ...chartDefaults.scales.x, grid: { display: false } },
            y: { ...chartDefaults.scales.y, max: 100, grid: { color: "rgba(255,255,255,0.03)" }, ticks: { color: "rgba(240,244,255,0.5)", callback: v => v + "%" } }
          }
        }
      });
    }

    const ctx2 = $("difficultyChart").getContext("2d");
    if (difficultyChartInstance) difficultyChartInstance.destroy();
    difficultyChartInstance = new Chart(ctx2, {
      type: "doughnut",
      data: { labels: ["Easy", "Medium", "Hard"], datasets: [{ data: [diffMap.easy, diffMap.medium, diffMap.hard], backgroundColor: ["rgba(32,210,150,0.8)", "rgba(60,130,220,0.8)", "rgba(220,80,80,0.8)"], borderColor: "rgba(255,255,255,0.08)", borderWidth: 2 }] },
      options: { responsive: true, plugins: { legend: { labels: { color: "#F0F4FF", font: { family: "Outfit" } } } } }
    });

    const ctx3 = $("topicChart").getContext("2d");
    if (topicChartInstance) topicChartInstance.destroy();
    if (topicPerf && topicPerf.length > 0) {
      const sorted = [...topicPerf].sort((a, b) => (b.correct_count + b.wrong_count) - (a.correct_count + a.wrong_count)).slice(0, 6);
      topicChartInstance = new Chart(ctx3, {
        type: "bar",
        data: {
          labels: sorted.map(t => t.topic),
          datasets: [
            { label: "Correct", data: sorted.map(t => t.correct_count), backgroundColor: "rgba(32,210,150,0.7)", borderColor: "#20D296", borderWidth: 1.5, borderRadius: 6 },
            { label: "Wrong", data: sorted.map(t => t.wrong_count), backgroundColor: "rgba(255,107,107,0.7)", borderColor: "#ff6b6b", borderWidth: 1.5, borderRadius: 6 }
          ]
        },
        options: { ...chartDefaults, scales: { x: { ticks: { color: "rgba(240,244,255,0.5)", maxRotation: 30 }, grid: { color: "rgba(255,255,255,0.05)" } }, y: { ticks: { color: "rgba(240,244,255,0.5)" }, grid: { color: "rgba(255,255,255,0.05)" }, beginAtZero: true } } }
      });
    } else {
      const sortedTopics = Object.entries(topicMap).sort((a, b) => b[1] - a[1]).slice(0, 6);
      topicChartInstance = new Chart(ctx3, {
        type: "bar",
        data: { labels: sortedTopics.map(t => t[0]), datasets: [{ label: "Quizzes", data: sortedTopics.map(t => t[1]), backgroundColor: "rgba(32,210,150,0.6)", borderColor: "#20D296", borderWidth: 1.5, borderRadius: 6 }] },
        options: { ...chartDefaults, scales: { x: { ticks: { color: "rgba(240,244,255,0.5)", maxRotation: 30 }, grid: { color: "rgba(255,255,255,0.05)" } }, y: { ticks: { color: "rgba(240,244,255,0.5)" }, grid: { color: "rgba(255,255,255,0.05)" }, beginAtZero: true } } }
      });
    }

    getAIAnalysis(topicPerf || []).then(analysis => {
      const box = $("ai-suggestions-content");
      const card = $("ai-suggestions-card");

      if (box && card) {
        card.style.display = "block";

        const formatList = (list) => {
          if (!list || list.length === 0) return "None";
          return list.map(item => typeof item === 'object' ? (item.topic || item.name || JSON.stringify(item)) : item).join(", ");
        };

        box.innerHTML = `
          <div style="margin-bottom:12px;">
            <div style="font-weight:600;color:var(--accent);margin-bottom:4px;">🔥 Strong Areas</div>
            <div style="color:var(--text-secondary);">${formatList(analysis.strong_topics)}</div>
          </div>
          <div style="margin-bottom:12px;">
            <div style="font-weight:600;color:#ff6b6b;margin-bottom:4px;">⚠️ Areas to Improve</div>
            <div style="color:var(--text-secondary);">${formatList(analysis.weak_topics)}</div>
          </div>
          <div style="padding:12px;background:rgba(255,255,255,0.03);border-radius:8px;border-left:3px solid var(--accent);">
            <div style="font-weight:600;margin-bottom:4px;">💡 Recommendation</div>
            <div style="font-style:italic;color:var(--text-primary);">${analysis.suggestion || "Keep practicing to get more personalized tips!"}</div>
          </div>
        `;
      }
    }).catch(err => {
      console.error("AI Analysis background error:", err);
    });

  } catch (err) {
    console.error("Load dashboard error:", err);
  }
}

function computeStreak(data) {
  if (!data || data.length === 0) return 0;
  const days = [...new Set(data.map(d => new Date(d.created_at).toDateString()))]
    .map(d => new Date(d)).sort((a, b) => b - a);
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  if (days[0].toDateString() !== today && days[0].toDateString() !== yesterday) return 0;
  let streak = 1;
  for (let i = 1; i < days.length; i++) {
    if (Math.round((days[i - 1] - days[i]) / 86400000) === 1) streak++;
    else break;
  }
  return streak;
}

function renderTopicMastery(topicPerf) {
  const list = $("topic-mastery-list");
  if (!list) return;

  if (!topicPerf || topicPerf.length === 0) {
    list.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted);grid-column:1/-1;">No topic data available yet. Complete a quiz to see your breakdown!</div>`;
    return;
  }

  const sorted = [...topicPerf].sort((a, b) => {
    const totalA = parseInt(a.correct_count || 0) + parseInt(b.wrong_count || 0);
    const totalB = parseInt(b.correct_count || 0) + parseInt(b.wrong_count || 0);
    return totalB - totalA;
  });

  list.innerHTML = sorted.map(t => {
    const correct = parseInt(t.correct_count || 0);
    const wrong = parseInt(t.wrong_count || 0);
    const total = correct + wrong;
    const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;
    const color = accuracy >= 80 ? "#20D296" : accuracy >= 50 ? "#f59e0b" : "#ff6b6b";

    return `
      <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div style="font-weight:600;color:var(--text-primary);font-size:15px;">${escapeHTML(t.topic)}</div>
          <div style="font-size:13px;font-weight:700;color:${color};">${accuracy}% Mastery</div>
        </div>
        
        <div style="height:8px;width:100%;background:rgba(255,255,255,0.05);border-radius:100px;overflow:hidden;display:flex;">
          <div style="width:${accuracy}%;height:100%;background:${color};box-shadow:0 0 10px ${color}44;"></div>
        </div>
        
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);font-weight:500;">
          <span>Correct: ${correct}</span>
          <span>Wrong: ${wrong}</span>
          <span>Total: ${total}</span>
        </div>
      </div>`;
  }).join("");
}

async function getAIAnalysis(topicPerf) {
  const totalQuizzes = (topicPerf || []).reduce((acc, t) => acc + (t.correct_count + t.wrong_count), 0);
  if (!topicPerf || topicPerf.length < 2 || totalQuizzes < 5) {
    return {
      strong_topics: [],
      weak_topics: [],
      suggestion: "Keep practicing! Once you complete 5+ quizzes across different topics, I'll analyze your mastery here. 🚀"
    };
  }

  const prompt = `
You are a learning science expert. 
Analyze these topic mastery metrics:

${JSON.stringify(topicPerf)}

Based on correct vs wrong counts, identify:
1. "strong_topics": [list of topic names where accuracy is high]
2. "weak_topics": [list of topic names where accuracy is low]
3. "suggestion": A one-sentence actionable tip.

Return ONLY valid JSON.
`;

  try {
    return await callAI([{ role: "user", content: prompt }], {
      parseJson: true,
      silent: true,
      fallback: {
        strong_topics: [],
        weak_topics: [],
        suggestion: "I'm taking a quick break! I'll have more insights for you later. Keep up the good work!"
      }
    });
  } catch (err) {
    console.error("AI Analysis Error:", err);
    return {
      strong_topics: [],
      weak_topics: [],
      suggestion: "Keep practicing to generate enough data for insights!"
    };
  }
}

// ================= UI EFFECTS =================
function updateDifficultyStyle(selectEl) {
  const value = selectEl.value;
  if (value === "easy") {
    selectEl.style.color = "#4ade80";
    selectEl.style.borderColor = "rgba(74, 222, 128, 0.5)";
    selectEl.style.boxShadow = "0 0 10px rgba(74, 222, 128, 0.2)";
  } else if (value === "medium") {
    selectEl.style.color = "#f0c040";
    selectEl.style.borderColor = "rgba(240, 192, 64, 0.5)";
    selectEl.style.boxShadow = "0 0 10px rgba(240, 192, 64, 0.2)";
  } else if (value === "hard") {
    selectEl.style.color = "#ff6b6b";
    selectEl.style.borderColor = "rgba(255, 107, 107, 0.5)";
    selectEl.style.boxShadow = "0 0 10px rgba(255, 107, 107, 0.2)";
  }

  setTimeout(() => {
    selectEl.style.borderColor = "";
    selectEl.style.boxShadow = "";
  }, 1500);
}

// ================= DOCUMENT QUIZ =================
async function generateQuizFromFile() {
  if (window.quizLifecycle.state !== "idle") return;
  if (window.isGenerating) return;

  const genBtn = document.getElementById("start-pdf-quiz-btn");
  const resultArea = $("pdf-quiz-result");

  try {
    window.isGenerating = true;
    resetEntireQuizEnvironment();
    window.activeQuizContext.mode = "new";

    const fileInput = $("file-upload");
    const count = $("file-quiz-count")?.value?.trim() || "10";
    const difficulty = $("file-quiz-difficulty")?.value || "medium";

    // 🔒 Question count limit validation
    const numCount = parseInt(count, 10);
    if (isNaN(numCount) || numCount < 1) {
      showDocQuizError("❌ Invalid Question Count", "Please enter a valid number of questions (1–50).");
      return;
    }
    if (numCount > MAX_QUIZ_QUESTIONS) {
      showDocQuizError("⚠️ Question Limit Exceeded", QUESTION_LIMIT_ERROR_MSG);
      return;
    }

    if (!fileInput?.files || fileInput.files.length === 0) {
      showDocQuizError("❌ No File Selected", "Please select a document to continue.");
      return;
    }

    const file = fileInput.files[0];
    if (resultArea) resultArea.innerHTML = "";

    if (genBtn) genBtn.textContent = "⏳ Reading Document...";
    showDocQuizLoading();

    let extractedText = await extractTextFromFile(file);
    if (!extractedText || extractedText.trim() === "") throw new Error("Could not extract any text.");

    if (extractedText.length > 15000) extractedText = extractedText.substring(0, 15000) + "...";
    if (genBtn) genBtn.textContent = "⏳ Generating Quiz...";

    const difficultyInstructions = {
      easy: "Focus on basic concepts found in the text.",
      medium: "Focus on application and inference from the text.",
      hard: "Focus on deep analysis, nuances, and complex implications of the text."
    };

    const parsedQuiz = await callAI([{
      role: "user",
      content: `STRICT JSON ONLY. No markdown. No backticks. No explanations.
Generate ${count} ${difficulty} MCQs based on the following text.
Difficulty Guideline: ${difficultyInstructions[difficulty]}

Format: [{"question":"","options":["","","",""],"answer":""}]

Text:
${extractedText}`
    }], { parseJson: true, timeoutMs: 30000 });

    if (!Array.isArray(parsedQuiz) || parsedQuiz.length === 0) throw new Error("Invalid quiz format received.");

    if (genBtn) genBtn.textContent = "⏳ Uploading Document...";
    const storageData = await uploadFileToStorage(file, AuthManager.user.id);

    Store.set({
      currentQuiz: parsedQuiz,
      currentQuizId: await storeQuizInDatabase("Doc: " + file.name, difficulty, parsedQuiz, {
        url: storageData.url,
        name: file.name,
        text: extractedText
      }),
      isQuizReview: false
    });

    if (Store.state.currentQuizId) await startNewAttempt(Store.state.currentQuizId);

    renderDocQuiz();
    Store.set({ quizStartTime: Date.now() });

    window.quizLifecycle.state = "generated";
    applyButtonState();
    // Show config for generated quiz
    const config = $("file-quiz-config");
    if (config) config.style.display = "block";

  } catch (error) {
    console.error("Doc Quiz error:", error);
    showDocQuizError("❌ Failed", error.message || "An error occurred.");
    window.isGenerating = false; // Fix Requirement 4: Release lock on failure
  } finally {
    window.isGenerating = false;
    applyButtonState();
    if (genBtn) {
      genBtn.textContent = "🚀 Generate Quiz from File";
    }
  }
}
window.generateQuizFromFile = generateQuizFromFile;

async function extractTextFromFile(file) {
  const name = file.name.toLowerCase();
  console.log(`[File] Starting extraction: ${file.name}`);

  try {
    if (name.endsWith('.pdf')) {
      const arrayBuffer = await file.arrayBuffer();
      if (!window.pdfjsLib) throw new Error("PDF library not loaded.");

      // Set worker source for pdf.js
      if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      }

      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      let fullText = "";
      const maxPages = Math.min(pdf.numPages, 10);
      for (let i = 1; i <= maxPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        fullText += textContent.items.map(item => item.str).join(" ") + "\n";
      }
      if (!fullText.trim()) throw new Error("No readable text found in PDF.");
      return fullText;
    } else if (name.endsWith('.docx')) {
      const arrayBuffer = await file.arrayBuffer();
      if (!window.mammoth) throw new Error("Mammoth library not loaded.");
      const result = await mammoth.extractRawText({ arrayBuffer });
      if (!result.value.trim()) throw new Error("No readable text found in DOCX.");
      return result.value;
    } else {
      const text = await file.text();
      if (!text.trim()) throw new Error("File is empty.");
      return text;
    }
  } catch (err) {
    console.error("Extraction error:", err);
    throw err;
  }
}

function showDocQuizLoading() {
  const container = $("pdf-quiz-container");
  if (!container) return;
  container.innerHTML = `
    <div style="text-align:center;padding:60px 20px;">
      <div style="font-size:48px;margin-bottom:20px;animation:spinBrain 1.5s linear infinite;display:inline-block">🧠</div>
      <div style="font-size:16px;font-weight:600;color:var(--accent);margin-bottom:16px;">Processing Document...</div>
    </div>`;
}

function showDocQuizError(title, message) {
  const container = $("pdf-quiz-container");
  container.innerHTML = `
    <div style="text-align:center;padding:40px 20px;background:rgba(255,107,107,0.08);border:1px solid rgba(255,107,107,0.2);border-radius:14px;margin-top:20px;">
      <div style="font-size:48px;margin-bottom:16px;">❌</div>
      <div style="font-size:18px;font-weight:600;color:#ff6b6b;margin-bottom:8px;">${title}</div>
      <div style="font-size:14px;color:var(--text-secondary);">${message}</div>
    </div>`;
}

function renderDocQuiz() {
  if (window.blockAutoRender) {
    console.warn("[Doc Guard] Render blocked by blockAutoRender flag");
    return;
  }

  const quizId = String(Store.state.currentQuizId);

  // 🔥 Safe Render Guard
  if (
    window.activeQuizContext &&
    window.activeQuizContext.quizId &&
    window.activeQuizContext.quizId !== quizId
  ) {
    console.warn("[Doc Context Guard] Blocked render for inactive quiz:", quizId, "(Active:", window.activeQuizContext.quizId, ")");
    return;
  }

  const container = $("pdf-quiz-container");
  if (!container) {
    console.error("PDF quiz container missing");
    return;
  }

  // 🔥 Guard: Do not render empty quiz container
  if (!Store.state.currentQuiz || Store.state.currentQuiz.length === 0) {
    console.warn("[Doc Guard] Blocked render for empty quiz data");
    container.style.display = "none";
    return;
  }

  // 🔥 Safety Guard: Reset button UI if we are in active play mode
  if (!Store.state.isQuizReview) {
    resetSubmitButtonUI();
  }

  // 🔥 STEP 1: ENGAGE RENDER LOCK
  window.isRenderingQuiz = true;

  console.log("Rendering PDF quiz:", quizId);

  container.innerHTML = "";

  // Scroll into view
  container.scrollIntoView({ behavior: "smooth", block: "start" });

  // Fallback Debug
  setTimeout(() => {
    if (container.innerHTML.trim() === "" && !window.blockAutoRender) {
      console.error("Render failed: PDF container is empty after load for quiz:", quizId);
    }
    // 🔥 STEP 3: RELEASE RENDER LOCK
    window.isRenderingQuiz = false;
  }, 500);

  const userAnswerSource = window.submittedQuizAnswers || Store.state.userAnswers;
  const isReviewMode = Store.state.isQuizReview || window.quizLifecycle.state === "submitted";

  Store.state.currentQuiz.forEach((q, i) => {
    const qBlock = document.createElement("div");
    qBlock.className = "quiz-question-block";
    qBlock.innerHTML = `
      <div class="quiz-question-text">${i + 1}. ${q.question}</div>
      <div class="quiz-options" id="pdf-opts-${i}"></div>
    `;
    container.appendChild(qBlock);

    const optsEl = qBlock.querySelector(`#pdf-opts-${i}`);
    q.options.forEach((opt) => {
      const btn = document.createElement("div");
      const isSelected = userAnswerSource[i] === opt;
      const isCorrect = String(q.answer).trim() === String(opt).trim();

      let reviewClass = "";
      if (isReviewMode) {
        if (isCorrect) reviewClass = "correct";
        else if (isSelected) reviewClass = "wrong";
      }

      btn.className = `quiz-option ${isSelected ? 'selected' : ''} ${reviewClass}`;
      btn.dataset.qi = i;
      btn.dataset.opt = opt;
      btn.textContent = opt;

      if (!Store.state.isQuizReview) {
        btn.onclick = () => selectDocAnswer(i, opt, btn);
      } else {
        btn.style.pointerEvents = "none";
        // Add indicator icons for review
        if (isCorrect) {
          btn.innerHTML += ' <span class="quiz-icon">✅</span>';
        } else if (isSelected) {
          btn.innerHTML += ' <span class="quiz-icon">❌</span>';
        }
      }
      optsEl.appendChild(btn);
    });
  });
  const submitBtn = $("pdf-submit-quiz-btn");
  const isSubmitted = Store.state.isQuizReview || (quizId && localStorage.getItem(`quiz_submitted_${quizId}`) === "true");

  if (submitBtn) {
    submitBtn.style.display = Store.state.isQuizReview ? "none" : "block";
  }
  applyButtonState();
}

function selectDocAnswer(qi, ans, clickedEl) {
  const newAnswers = { ...Store.state.userAnswers };
  newAnswers[qi] = ans;
  Store.set({ userAnswers: newAnswers });
  window.currentQuizAnswers[qi] = ans;

  document.querySelectorAll(`#pdf-opts-${qi} .quiz-option`).forEach(el => el.classList.remove("selected"));
  clickedEl.classList.add("selected");

  // Clear validation highlight and error message when user answers a question
  const questionBlock = clickedEl.closest('.quiz-question-block');
  if (questionBlock) {
    questionBlock.classList.remove('unanswered-highlight');
    const errEl = questionBlock.querySelector('.question-error-msg');
    if (errEl) errEl.remove();
  }

  // Real-time sync to Supabase (same as regular quiz)
  if (Store.state.currentAttemptId) {
    supabaseClient?.from("user_answers").upsert({
      user_id: AuthManager.user?.id,
      attempt_id: Store.state.currentAttemptId,
      question_id: qi,
      selected_answer: ans
    }, { onConflict: 'attempt_id,question_id' }).then(() => { }).catch(e => console.warn("Doc answer sync error:", e));

    supabaseClient?.from("quiz_attempts").update({
      last_question_index: qi,
      updated_at: new Date()
    }).eq("attempt_id", Store.state.currentAttemptId).then(() => { }).catch(e => console.warn("Doc attempt sync error:", e));
  }

  saveQuizProgress();
  applyButtonState();
}

// Doc quiz submit — directly calls the core submit logic with correct context
async function submitDocQuiz() {
  if (window._isSubmittingQuiz) return;

  // 🔒 Mandatory answer validation — block submission if any question is unanswered
  if (!validateAllQuestionsAnswered('#pdf-quiz-container')) {
    return;
  }

  window._isSubmittingQuiz = true;

  document.querySelectorAll(".quiz-option").forEach(el => el.style.pointerEvents = "none");
  const submitBtn = $("pdf-submit-quiz-btn");
  if (submitBtn) {
    submitBtn.textContent = "🧠 AI is verifying answers...";
    submitBtn.disabled = true;
  }

  try {

    const quizPayload = Store.state.currentQuiz.map((q, i) => ({
      question: q.question,
      options: q.options,
      correct_answer: q.answer,
      user_answer: Store.state.userAnswers[i] || "Not answered"
    }));

    const prompt = `You are a quiz evaluator. Evaluate each question below and return ONLY a valid JSON array with no markdown, no backticks, no extra text.

For each item return:
{"question":"...","user_answer":"...","correct_answer":"...","is_correct":true,"explanation":"1-2 sentence explanation of the correct answer"}

Quiz data:
${JSON.stringify(quizPayload)}`;

    let results = [];
    try {
      results = await callAI([{ role: "user", content: prompt }], { parseJson: true });
    } catch {
      results = Store.state.currentQuiz.map((q, i) => {
        const userAns = Store.state.userAnswers[i] || "Not answered";
        return {
          question: q.question,
          user_answer: userAns,
          correct_answer: q.answer,
          is_correct: userAns === q.answer,
          explanation: `The correct answer is: ${q.answer}`
        };
      });
    }

    // Highlight options
    results.forEach((r, i) => {
      document.querySelectorAll(`#pdf-opts-${i} .quiz-option`).forEach(el => {
        const opt = el.dataset.opt;
        if (opt === r.correct_answer || opt === r.correct_answer?.replace(/^[A-D]\.\s*/, "")) {
          el.classList.add("correct");
        } else if (!r.is_correct && (opt === r.user_answer || opt === r.user_answer?.replace(/^[A-D]\.\s*/, ""))) {
          el.classList.add("wrong");
        }
      });
    });

    // Render result using unified function
    const total = results.length;
    const score = results.filter(r => r.is_correct).length;

    const att = {
      score,
      total_questions: total,
      created_at: new Date(),
      status: 'completed',
      quiz: window._docQuizMeta
    };

    // Need to ensure the container is correct for PDF quiz
    const pdfResultDiv = $("pdf-quiz-result");
    if (pdfResultDiv) {
      renderCompletedAttemptWithContainer(pdfResultDiv, att, results);
    }

    if (submitBtn) submitBtn.style.display = "none";
    toggleNewQuizButton(false);

    // Save to database
    const startTime = Store.state.quizStartTime;
    const timeTaken = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;

    if (Store.state.currentAttemptId) {
      try {
        await supabaseClient?.from("quiz_attempts").update({
          score,
          status: 'completed',
          time_taken: timeTaken,
          updated_at: new Date()
        }).eq("attempt_id", Store.state.currentAttemptId);

        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          await supabaseClient?.from("user_answers").upsert({
            user_id: AuthManager.user?.id,
            attempt_id: Store.state.currentAttemptId,
            question_id: i,
            selected_answer: r.user_answer,
            is_correct: r.is_correct,
            explanation: r.explanation
          }, { onConflict: 'attempt_id,question_id' });
        }
      } catch (e) {
        console.error("Doc quiz save error:", e);
      }
    }

    // Update topic performance
    const meta = window._quizMeta || {};
    const quizTopic = meta.topic || "Document Quiz";
    const topicCounts = { correct: 0, wrong: 0 };
    results.forEach(r => { if (r.is_correct) topicCounts.correct++; else topicCounts.wrong++; });
    try {
      const { data: existing, error: fetchErr } = await supabaseClient?.from("user_topic_performance")
        .select("*")
        .eq("user_id", AuthManager.user?.id)
        .eq("topic", quizTopic)
        .single();

      if (fetchErr && fetchErr.code !== 'PGRST116') { // PGRST116 is 'No rows found' for .single()
        handleSupabaseError(fetchErr, "Fetch topic performance");
      }

      if (existing) {
        const { error: upErr } = await supabaseClient?.from("user_topic_performance").update({
          correct_count: existing.correct_count + topicCounts.correct,
          wrong_count: existing.wrong_count + topicCounts.wrong
        }).eq("id", existing.id);
        handleSupabaseError(upErr, "Update topic performance");
      } else {
        const { error: insErr } = await supabaseClient?.from("user_topic_performance").insert({
          user_id: AuthManager.user?.id,
          topic: quizTopic,
          correct_count: topicCounts.correct,
          wrong_count: topicCounts.wrong
        });
        handleSupabaseError(insErr, "Insert topic performance");
      }
    } catch (e) { console.warn("Doc topic performance update error:", e); }

    clearQuizProgress(Store.state.currentQuizId);
    updateDashboardLive(score, total, meta);
    updateLeaderboardScore(score, total);
    await loadPreviousQuizzes();
  } catch (err) {
    console.error("Doc quiz submission fatal error:", err);
    showGlobalError("Submission failed. Please check your connection.");
  } finally {
    window._isSubmittingQuiz = false;
    window.quizLifecycle.state = "submitted";
    applyButtonState();
  }
}

// Map the submit logic for Document Quiz to the existing submit logic by overriding DOM targets briefly
function toggleNewQuizButton(disabled) {
  const btn1 = $("generate-new-quiz-btn");
  const btn2 = $("pdf-generate-new-quiz-btn");
  const config = {
    opacity: disabled ? "0.5" : "1",
    cursor: disabled ? "not-allowed" : "pointer",
    title: disabled ? "Please submit your current quiz first" : ""
  };

  if (btn1) {
    btn1.disabled = disabled;
    Object.assign(btn1.style, config);
    btn1.title = config.title;
  }
  if (btn2) {
    btn2.disabled = disabled;
    Object.assign(btn2.style, config);
    btn2.title = config.title;
  }
}

const originalSubmitQuiz = submitQuiz;
window.submitQuiz = async function () {
  if ($("pdf").classList.contains("active")) {
    await submitDocQuiz();
  } else {
    await originalSubmitQuiz();
  }
};

// ================= RESIZE PANELS =================
function setupResizeHandle(handleId, rightPanelId, minWidth, maxWidth) {
  const handle = $(handleId);
  const rightPanel = $(rightPanelId);
  if (!handle || !rightPanel) return;

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener('mousedown', (e) => {
    isResizing = true;
    startX = e.clientX;
    startWidth = rightPanel.offsetWidth;
    handle.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const delta = startX - e.clientX;
    const newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + delta));

    // Apply width and flex-basis for maximum compatibility with flexbox
    rightPanel.style.width = `${newWidth}px`;
    rightPanel.style.minWidth = `${newWidth}px`;
    rightPanel.style.flexBasis = `${newWidth}px`;
    rightPanel.style.flex = 'none';
  });

  window.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    handle.classList.remove('resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initResizeHandles);
} else {
  initResizeHandles();
}

function initResizeHandles() {
  setupResizeHandle('chat-panel-resizer', 'chat-panel', 180, 480);
  setupResizeHandle('quiz-panel-resizer', 'quiz-panel', 160, 500);
  setupResizeHandle('pdf-panel-resizer', 'pdf-panel', 160, 500);

  // Main sidebar resizer (left to right)
  const mainResizer = $('main-sidebar-resizer');
  const sidebar = document.querySelector('.sidebar');
  if (mainResizer && sidebar) {
    let isResizing = false;
    mainResizer.addEventListener('mousedown', (e) => {
      isResizing = true;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const newWidth = Math.max(180, Math.min(400, e.clientX));
      document.documentElement.style.setProperty('--sidebar-w', `${newWidth}px`);
      sidebar.style.width = `${newWidth}px`;
    });
    window.addEventListener('mouseup', () => {
      isResizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }
}

// ── File Handling for Upload Notes ──
function handleFileSelect(input) {
  // Use resetEntireQuizEnvironment instead of resetQuizState to keep things in sync
  resetEntireQuizEnvironment();

  const dropArea = $('file-drop-area');
  const info = $('selected-file-info');
  const text = $('selected-file-name');

  if (input.files && input.files[0]) {
    if (dropArea) {
      dropArea.style.borderColor = 'var(--accent)';
      dropArea.style.background = 'rgba(32, 210, 150, 0.05)';
    }
    if (info) info.style.display = 'block';
    if (text) text.textContent = input.files[0].name;

    // Show config
    const config = $("file-quiz-config");
    if (config) config.style.display = "block";

    window.isFileUploaded = true;
    applyButtonState();
    console.log("[Upload] File ready → Generate enabled:", input.files[0].name);
  } else {
    removeSelectedFile();
  }
}
window.handleFileSelect = handleFileSelect;

function removeSelectedFile() {
  const input = $('file-upload');
  if (input) input.value = "";
  resetUploadUI();
  window.isFileUploaded = false;
  resetEntireQuizEnvironment();
}
window.removeSelectedFile = removeSelectedFile;

function resetUploadUI() {
  const dropArea = $('file-drop-area');
  const info = $('selected-file-info');
  const text = $('selected-file-name');
  const config = $('file-quiz-config');

  if (dropArea) {
    dropArea.style.borderColor = 'var(--border)';
    dropArea.style.background = 'rgba(255,255,255,0.01)';
  }
  if (info) info.style.display = 'none';
  if (text) text.textContent = '';
  if (config) config.style.display = 'none';

  // Clear any existing quiz/result if file is removed
  const container = $("pdf-quiz-container");
  if (container) container.innerHTML = "";
  const result = $("pdf-quiz-result");
  if (result) result.innerHTML = "";
  const submitBtn = $("pdf-submit-quiz-btn");
  if (submitBtn) submitBtn.style.display = "none";
}



// ================= VIRTUAL SCROLLING =================
function createVirtualList(container, items, renderItem, itemHeight = 60) {
  container.innerHTML = "";

  const viewportHeight = container.clientHeight;
  const visibleCount = Math.ceil(viewportHeight / itemHeight) + 5;

  let scrollTop = 0;

  const spacer = document.createElement("div");
  spacer.style.height = items.length * itemHeight + "px";
  container.appendChild(spacer);

  const visibleContainer = document.createElement("div");
  visibleContainer.style.position = "absolute";
  visibleContainer.style.left = "0";
  visibleContainer.style.right = "0";

  container.style.position = "relative";
  container.appendChild(visibleContainer);

  function render() {
    const start = Math.floor(scrollTop / itemHeight);
    const end = start + visibleCount;

    visibleContainer.innerHTML = "";

    for (let i = start; i < end && i < items.length; i++) {
      const el = renderItem(items[i], i);
      el.style.position = "absolute";
      el.style.top = i * itemHeight + "px";
      el.style.width = "100%";
      visibleContainer.appendChild(el);
    }
  }

  container.addEventListener("scroll", () => {
    scrollTop = container.scrollTop;
    render();
  });

  render();
}

/**
 * Service Worker Registration for PWA Support
 */
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .then((reg) => console.log('[SW] Service Worker Registered Successfully:', reg.scope))
        .catch((err) => console.error('[SW] Service Worker Registration Failed:', err));
    });
  }
}


