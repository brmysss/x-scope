(() => {
  const core = globalThis.XScopeCore
  if (!core || document.querySelector("#xscope-root")) return

  const SCAN_DELAY = 700
  const MAX_ROUNDS = 180
  const MAX_TWEETS = 1_000
  const IDLE_ROUNDS_TO_STOP = 12
  const STORAGE_PREFIX = "xscope-profile-"

  const state = {
    handle: null,
    profileData: { tweets: [], scannedAt: null },
    sortKey: "likes",
    originalOnly: true,
    isScanning: false,
    stopRequested: false,
    route: location.href,
  }

  const root = document.createElement("div")
  root.id = "xscope-root"
  const shadow = root.attachShadow({ mode: "open" })
  shadow.innerHTML = `
    <link rel="stylesheet" href="${chrome.runtime.getURL("src/styles.css")}" />
    <button class="launcher" data-action="open" aria-label="打开 XScope">X</button>
    <section class="panel is-hidden" aria-label="XScope 用户热度">
      <header class="panel-header">
        <div>
          <div class="eyebrow">XSCOPE / LOCAL TOOLBOX</div>
          <h1>用户热度</h1>
          <div class="handle" data-role="handle">等待用户主页…</div>
        </div>
        <button class="icon-button" data-action="hide" aria-label="收起侧栏">×</button>
      </header>

      <div class="privacy-note">只读取当前页面已加载的公开内容，数据保存在本地。</div>

      <div class="actions">
        <button class="primary-button" data-action="scan">扫描当前用户</button>
        <button class="secondary-button is-hidden" data-action="stop">停止</button>
      </div>

      <div class="status" data-role="status">打开 X 用户主页后点击扫描。</div>

      <div class="stats">
        <div><strong data-role="total">0</strong><span>已收集</span></div>
        <div><strong data-role="oldest">—</strong><span>最早日期</span></div>
        <div><strong data-role="updated">—</strong><span>上次扫描</span></div>
      </div>

      <div class="filters">
        <button class="filter is-active" data-sort="likes">最多点赞</button>
        <button class="filter" data-sort="replies">最多回复</button>
        <button class="filter" data-sort="reposts">最多转发</button>
        <button class="filter" data-sort="views">最多浏览</button>
      </div>

      <label class="checkbox-row">
        <input type="checkbox" data-action="original-only" checked />
        <span>只看原创推文</span>
      </label>

      <div class="coverage" data-role="coverage">尚未扫描；这里不会承诺覆盖全部历史。</div>
      <ol class="tweet-list" data-role="list"></ol>
      <footer>v0.1 · 扫描上限 1,000 条 · XScope</footer>
    </section>
  `
  document.documentElement.appendChild(root)

  const elements = {
    launcher: shadow.querySelector('[data-action="open"]'),
    panel: shadow.querySelector(".panel"),
    handle: shadow.querySelector('[data-role="handle"]'),
    status: shadow.querySelector('[data-role="status"]'),
    total: shadow.querySelector('[data-role="total"]'),
    oldest: shadow.querySelector('[data-role="oldest"]'),
    updated: shadow.querySelector('[data-role="updated"]'),
    coverage: shadow.querySelector('[data-role="coverage"]'),
    list: shadow.querySelector('[data-role="list"]'),
    scan: shadow.querySelector('[data-action="scan"]'),
    stop: shadow.querySelector('[data-action="stop"]'),
    originalOnly: shadow.querySelector('[data-action="original-only"]'),
    filters: [...shadow.querySelectorAll("[data-sort]")],
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;")
  }

  function storageKey(handle) {
    return `${STORAGE_PREFIX}${handle.toLowerCase()}`
  }

  async function loadProfile(handle) {
    const key = storageKey(handle)
    const result = await chrome.storage.local.get(key)
    return result[key] || { handle, tweets: [], scannedAt: null }
  }

  async function saveProfile(handle, profileData) {
    await chrome.storage.local.set({
      [storageKey(handle)]: {
        handle,
        tweets: profileData.tweets.slice(0, MAX_TWEETS),
        scannedAt: profileData.scannedAt,
      },
    })
  }

  function formatDate(value) {
    if (!value) return "未知日期"
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return "未知日期"
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date)
  }

  function formatScanTime(value) {
    if (!value) return "—"
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return "—"
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date)
  }

  function setStatus(message) {
    elements.status.textContent = message
  }

  function updateContext() {
    const profile = core.parseProfileFromPath(location.pathname)
    if (!profile) {
      root.style.display = "none"
      state.handle = null
      return null
    }

    root.style.display = "block"
    if (profile.handle !== state.handle) {
      state.handle = profile.handle
      state.profileData = { tweets: [], scannedAt: null }
      togglePanel(true)
      void loadProfile(profile.handle).then((data) => {
        if (state.handle !== profile.handle) return
        state.profileData = data
        render()
        setStatus(data.tweets.length ? "已载入本地缓存，可继续扫描。" : "尚未扫描这个用户。")
      })
    }

    elements.handle.textContent = `@${profile.handle}`
    return profile
  }

  function captureVisibleTweets() {
    return [...document.querySelectorAll('article[data-testid="tweet"]')]
      .map((article) => core.parseTweetArticle(article, state.handle))
      .filter(Boolean)
  }

  function findOldestDate(tweets) {
    const dates = tweets
      .map((tweet) => new Date(tweet.createdAt || 0).getTime())
      .filter((time) => Number.isFinite(time) && time > 0)
    return dates.length ? new Date(Math.min(...dates)).toISOString() : null
  }

  function renderTweet(tweet, rank) {
    const text = tweet.text || "（这条推文没有可读取的文字，可能主要是媒体内容）"
    const metrics = [
      `♥ ${core.formatMetric(tweet.likes)}`,
      `↩ ${core.formatMetric(tweet.replies)}`,
      `↻ ${core.formatMetric(tweet.reposts)}`,
      `◉ ${core.formatMetric(tweet.views)}`,
    ].join(" · ")
    const tags = [tweet.isReply ? "回复" : "", tweet.isRetweet ? "转发" : "", tweet.hasMedia ? "媒体" : ""]
      .filter(Boolean)
      .join(" / ")

    return `
      <li class="tweet-item">
        <a href="${escapeHtml(tweet.url)}" target="_blank" rel="noopener noreferrer">
          <div class="tweet-topline"><span class="rank">#${rank}</span><span>${escapeHtml(formatDate(tweet.createdAt))}</span></div>
          <p>${escapeHtml(text)}</p>
          <div class="tweet-metrics">${escapeHtml(metrics)}</div>
          ${tags ? `<div class="tweet-tags">${escapeHtml(tags)}</div>` : ""}
        </a>
      </li>
    `
  }

  function render() {
    const tweets = state.profileData.tweets || []
    const originalCount = tweets.filter((tweet) => !tweet.isReply && !tweet.isRetweet).length
    const topTweets = core.getTopTweets(tweets, state.sortKey, 10, state.originalOnly)
    const oldest = findOldestDate(tweets)

    elements.total.textContent = String(tweets.length)
    elements.oldest.textContent = formatDate(oldest)
    elements.updated.textContent = formatScanTime(state.profileData.scannedAt)
    elements.coverage.textContent = tweets.length
      ? `已扫描 ${tweets.length} 条（原创 ${originalCount} 条）。这是本地扫描结果，不等于账号全部历史。`
      : "尚未扫描；这里不会承诺覆盖全部历史。"
    elements.list.innerHTML = topTweets.length
      ? topTweets.map((tweet, index) => renderTweet(tweet, index + 1)).join("")
      : `<li class="empty">暂无结果。请确认当前是用户主页的“帖子 / Posts”标签。</li>`

    elements.filters.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.sort === state.sortKey)
    })
  }

  async function scanCurrentProfile() {
    const profile = updateContext()
    if (!profile || state.isScanning) return

    state.isScanning = true
    state.stopRequested = false
    elements.scan.classList.add("is-hidden")
    elements.stop.classList.remove("is-hidden")
    setStatus("准备扫描页面中已加载的推文…")

    const originalScrollY = window.scrollY
    let idleRounds = 0
    let previousCount = state.profileData.tweets.length

    try {
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        if (state.stopRequested || state.handle !== profile.handle) break

        const visibleTweets = captureVisibleTweets()
        state.profileData.tweets = core.mergeTweets(state.profileData.tweets, visibleTweets).slice(0, MAX_TWEETS)
        const currentCount = state.profileData.tweets.length
        const newCount = currentCount - previousCount
        previousCount = currentCount
        idleRounds = newCount > 0 ? 0 : idleRounds + 1
        render()

        if (currentCount >= MAX_TWEETS) {
          setStatus(`已达到 ${MAX_TWEETS} 条扫描上限，可以停止扫描。`)
          break
        }
        if (idleRounds >= IDLE_ROUNDS_TO_STOP) {
          setStatus("页面暂时没有加载更多内容，扫描结束。")
          break
        }

        setStatus(`扫描中：已收集 ${currentCount} 条，继续向下加载…`)
        window.scrollBy(0, Math.max(window.innerHeight * 0.82, 560))
        await sleep(SCAN_DELAY)
      }
    } finally {
      state.profileData.scannedAt = new Date().toISOString()
      await saveProfile(profile.handle, state.profileData)
      window.scrollTo(0, originalScrollY)
      state.isScanning = false
      state.stopRequested = false
      elements.scan.classList.remove("is-hidden")
      elements.stop.classList.add("is-hidden")
      render()
      if (!elements.status.textContent.startsWith("已达到") && !elements.status.textContent.startsWith("页面暂时")) {
        setStatus(`扫描完成：本地收集 ${state.profileData.tweets.length} 条。`)
      }
    }
  }

  function togglePanel(forceOpen) {
    const shouldOpen = forceOpen === undefined ? elements.panel.classList.contains("is-hidden") : forceOpen
    elements.panel.classList.toggle("is-hidden", !shouldOpen)
    elements.launcher.classList.toggle("is-hidden", shouldOpen)
  }

  shadow.addEventListener("click", (event) => {
    const target = event.target.closest("button")
    if (!target) return

    if (target.dataset.action === "open") togglePanel(true)
    if (target.dataset.action === "hide") togglePanel(false)
    if (target.dataset.action === "scan") void scanCurrentProfile()
    if (target.dataset.action === "stop") state.stopRequested = true
    if (target.dataset.sort) {
      state.sortKey = target.dataset.sort
      render()
    }
  })

  elements.originalOnly.addEventListener("change", () => {
    state.originalOnly = elements.originalOnly.checked
    render()
  })

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "toggle-panel") togglePanel()
  })

  updateContext()
  render()

  window.setInterval(() => {
    if (location.href === state.route) return
    state.route = location.href
    updateContext()
    render()
  }, 500)

  const observer = new MutationObserver(() => {
    if (state.handle && !state.isScanning) {
      const profile = core.parseProfileFromPath(location.pathname)
      if (profile && profile.handle === state.handle) elements.handle.textContent = `@${profile.handle}`
    }
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
})()
