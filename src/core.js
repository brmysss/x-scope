(() => {
  const RESERVED_ROUTES = new Set([
    "home",
    "explore",
    "notifications",
    "messages",
    "bookmarks",
    "lists",
    "communities",
    "search",
    "settings",
    "i",
    "compose",
    "login",
    "signup",
    "tos",
    "privacy",
    "jobs",
    "account",
    "ads",
    "premium",
    "intent",
    "hashtag",
    "download",
  ])

  const UNIT_MULTIPLIERS = {
    k: 1_000,
    m: 1_000_000,
    b: 1_000_000_000,
    万: 10_000,
    亿: 100_000_000,
  }

  function parseMetric(value) {
    if (value === null || value === undefined) return null

    const text = String(value).replace(/\u00a0/g, " ").trim()
    const match = text.match(/(\d+(?:[.,]\d+)?)(?:\s*)([kKmMbB万亿]?)/)
    if (!match) return null

    const number = Number(match[1].replace(/,/g, ""))
    if (!Number.isFinite(number)) return null

    const unit = match[2]
    return Math.round(number * (UNIT_MULTIPLIERS[unit.toLowerCase()] || 1))
  }

  function formatMetric(value) {
    const number = Number(value) || 0
    if (number >= 100_000_000) return `${trimDecimal(number / 100_000_000)}亿`
    if (number >= 10_000) return `${trimDecimal(number / 10_000)}万`
    if (number >= 1_000) return `${trimDecimal(number / 1_000)}k`
    return String(number)
  }

  function trimDecimal(value) {
    return Number(value.toFixed(value >= 100 ? 0 : 1)).toString()
  }

  function extractStatusId(value) {
    if (!value) return null
    const match = String(value).match(/\/status\/(\d+)/)
    return match ? match[1] : null
  }

  function parseProfileFromPath(pathname) {
    const segments = String(pathname || "")
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean)

    if (!segments.length) return null

    const first = decodeURIComponent(segments[0]).replace(/^@/, "")
    if (!first || RESERVED_ROUTES.has(first.toLowerCase())) return null
    if (!/^[a-zA-Z0-9_]{1,20}$/.test(first)) return null

    return {
      handle: first,
      isTweetDetail: segments.includes("status"),
    }
  }

  function textOf(element) {
    return (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim()
  }

  function readMetricFromSelectors(article, selectors) {
    for (const selector of selectors) {
      for (const element of article.querySelectorAll(selector)) {
        const candidates = [element.getAttribute("aria-label"), element.getAttribute("title"), textOf(element)]
        for (const candidate of candidates) {
          const parsed = parseMetric(candidate)
          if (parsed !== null) return parsed
        }
      }
    }
    return 0
  }

  function parseTweetArticle(article, profileHandle) {
    if (!article) return null

    const statusLink = [...article.querySelectorAll('a[href*="/status/"]')].find((link) =>
      extractStatusId(link.getAttribute("href")),
    )
    const id = extractStatusId(statusLink?.getAttribute("href"))
    if (!id) return null

    const text = textOf(article.querySelector('[data-testid="tweetText"]'))
    const time = article.querySelector("time")
    const createdAt = time?.getAttribute("datetime") || null
    const authorBlock = article.querySelector('[data-testid="User-Name"]')
    const authorText = textOf(authorBlock)
    const handleMatch = authorText.match(/@([a-zA-Z0-9_]{1,20})/)
    const context = textOf(article.querySelector('[data-testid="socialContext"]')).toLowerCase()

    return {
      id,
      url: new URL(statusLink.getAttribute("href"), globalThis.location?.origin || "https://x.com").href,
      text,
      author: handleMatch ? `@${handleMatch[1]}` : `@${profileHandle}`,
      createdAt,
      likes: readMetricFromSelectors(article, ['[data-testid="like"]', '[data-testid="unlike"]']),
      replies: readMetricFromSelectors(article, ['[data-testid="reply"]']),
      reposts: readMetricFromSelectors(article, ['[data-testid="retweet"]', '[data-testid="unretweet"]']),
      quotes: readMetricFromSelectors(article, ['[data-testid="quoteTweet"]']),
      views: readMetricFromSelectors(article, ['a[href*="/analytics"]', '[data-testid="viewCount"]']),
      isRetweet: /reposted|retweeted|转发|转推/.test(context),
      isReply: /replying to|replied|回复|回应/.test(context),
      hasMedia: Boolean(article.querySelector('[data-testid="tweetPhoto"], video, [data-testid="card.wrapper"]')),
      capturedAt: new Date().toISOString(),
    }
  }

  function mergeTweets(existing, incoming) {
    const byId = new Map()
    for (const tweet of [...(existing || []), ...(incoming || [])]) {
      if (!tweet?.id) continue
      const previous = byId.get(tweet.id)
      byId.set(tweet.id, previous ? { ...previous, ...tweet } : tweet)
    }
    return [...byId.values()].sort((left, right) => {
      const leftTime = new Date(left.createdAt || 0).getTime()
      const rightTime = new Date(right.createdAt || 0).getTime()
      return rightTime - leftTime
    })
  }

  function getTopTweets(tweets, sortKey = "likes", limit = 10, originalOnly = true) {
    const eligible = (tweets || []).filter((tweet) => {
      if (!originalOnly) return true
      return !tweet.isRetweet && !tweet.isReply
    })

    return [...eligible]
      .sort((left, right) => {
        const metricDifference = (Number(right[sortKey]) || 0) - (Number(left[sortKey]) || 0)
        if (metricDifference) return metricDifference
        return new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime()
      })
      .slice(0, limit)
  }

  const api = {
    formatMetric,
    getTopTweets,
    mergeTweets,
    parseMetric,
    parseProfileFromPath,
    parseTweetArticle,
    extractStatusId,
  }

  globalThis.XScopeCore = api
  if (typeof module !== "undefined" && module.exports) module.exports = api
})()
