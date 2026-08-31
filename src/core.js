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

  function parseSearchContext(pathname, search) {
    const segments = String(pathname || "")
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean)

    if (segments.length !== 1 || segments[0].toLowerCase() !== "search") return null

    const query = new URLSearchParams(search || "").get("q") || ""
    const match = query.match(/(?:^|\s)from:([a-zA-Z0-9_]{1,20})(?=\s|$)/i)
    if (!match) return null

    return {
      handle: match[1],
      query,
    }
  }

  function extractSearchText(query) {
    return String(query || "")
      .replace(/(?:^|\s)from:[^\s]+/gi, " ")
      .replace(/(?:^|\s)(?:since|until|lang|min_faves|min_replies|min_retweets):[^\s]+/gi, " ")
      .replace(/(?:^|\s)-is:[^\s]+/gi, " ")
      .replace(/\bOR\b/gi, " ")
      .replace(/[()"]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  }

  function buildXSearchQuery(handle, input) {
    const normalizedHandle = String(handle || "").replace(/^@/, "").trim()
    const withoutFrom = String(input || "")
      .replace(/(?:^|\s)from:[a-zA-Z0-9_]{1,20}/gi, " ")
      .replace(/\s+/g, " ")
      .trim()

    return withoutFrom ? `from:${normalizedHandle} ${withoutFrom}` : `from:${normalizedHandle}`
  }

  function buildXSearchUrl(handle, input) {
    const url = new URL("https://x.com/search")
    url.searchParams.set("q", buildXSearchQuery(handle, input))
    url.searchParams.set("src", "typed_query")
    url.searchParams.set("f", "live")
    return url.href
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

  function unwrapGraphqlTweet(value) {
    if (!value || typeof value !== "object") return null

    let result = value
    if (result.__typename === "TweetWithVisibilityResults") result = result.tweet
    if (result?.tweet && !result.rest_id) result = result.tweet
    if (!result || typeof result !== "object" || !result.rest_id) return null
    return result
  }

  function extractGraphqlTweet(value, fallbackHandle) {
    const tweet = unwrapGraphqlTweet(value)
    if (!tweet) return null

    const legacy = tweet.legacy || {}
    const user = tweet.core?.user_results?.result || {}
    const userLegacy = user.legacy || {}
    const handle = userLegacy.screen_name || user.core?.screen_name || fallbackHandle || "unknown"
    const id = String(tweet.rest_id)
    const media = legacy.extended_entities?.media || legacy.entities?.media || []

    return {
      id,
      url: `https://x.com/${handle}/status/${id}`,
      text: tweet.note_tweet?.note_tweet_results?.result?.text || legacy.full_text || "",
      author: `@${handle}`,
      createdAt: legacy.created_at || tweet.created_at || null,
      likes: Number(legacy.favorite_count) || 0,
      replies: Number(legacy.reply_count) || 0,
      reposts: Number(legacy.retweet_count) || 0,
      quotes: Number(legacy.quote_count) || 0,
      views: Number(tweet.views?.count) || 0,
      isRetweet: Boolean(legacy.retweeted_status_result || /^RT @/i.test(legacy.full_text || "")),
      isReply: Boolean(legacy.in_reply_to_status_id_str || legacy.in_reply_to_user_id_str),
      hasMedia: Array.isArray(media) && media.length > 0,
      capturedAt: new Date().toISOString(),
      source: "graphql",
    }
  }

  function graphqlInstructionSets(value) {
    const root = value?.data && typeof value.data === "object" ? value.data : value
    return [
      root?.user?.result?.timeline_v2?.timeline?.instructions,
      root?.user?.result?.timeline?.timeline?.instructions,
      root?.search_by_raw_query?.search_timeline?.timeline?.instructions,
      root?.searchTimeline?.timeline?.instructions,
      root?.search?.search_timeline?.timeline?.instructions,
    ].filter(Array.isArray)
  }

  function parseGraphqlTimeline(value, profileHandle = null) {
    const tweets = []
    const seen = new Set()
    let nextCursor = null
    const normalizedHandle = String(profileHandle || "").replace(/^@/, "").toLowerCase()

    function visit(node) {
      if (!node || typeof node !== "object") return

      if (node.type === "TimelinePinEntry") return

      if (node.entryId?.startsWith("cursor-bottom-") && node.content?.value) {
        nextCursor = node.content.value
      }
      if (node.cursorType === "Bottom" && node.value) nextCursor = node.value

      const result = node.tweet_results?.result
      if (result) {
        const tweet = extractGraphqlTweet(result, profileHandle)
        const authorHandle = tweet?.author?.replace(/^@/, "").toLowerCase()
        const belongsToProfile = !normalizedHandle || !authorHandle || authorHandle === normalizedHandle
        if (tweet && belongsToProfile && !seen.has(tweet.id)) {
          seen.add(tweet.id)
          tweets.push(tweet)
        }
      }

      if (Array.isArray(node)) {
        node.forEach(visit)
        return
      }

      Object.values(node).forEach((child) => {
        if (child && typeof child === "object") visit(child)
      })
    }

    graphqlInstructionSets(value).forEach((instructions) => instructions.forEach(visit))
    return { tweets, nextCursor }
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

  function searchTweets(tweets, query, sortKey = "likes", limit = 10, originalOnly = false) {
    const groups = String(query || "")
      .toLocaleLowerCase()
      .replace(/[()"]+/g, " ")
      .split(/\s+or\s+/i)
      .map((group) => group.split(/\s+/).filter(Boolean))
      .filter((group) => group.length > 0)

    if (!groups.length) return getTopTweets(tweets, sortKey, limit, originalOnly)

    const matches = (tweets || []).filter((tweet) => {
      const haystack = `${tweet.text || ""} ${tweet.author || ""}`.toLocaleLowerCase()
      return groups.some((group) => group.every((term) => haystack.includes(term)))
    })

    return getTopTweets(matches, sortKey, limit, originalOnly)
  }

  const api = {
    formatMetric,
    buildXSearchQuery,
    buildXSearchUrl,
    extractGraphqlTweet,
    extractSearchText,
    getTopTweets,
    mergeTweets,
    parseMetric,
    parseProfileFromPath,
    parseSearchContext,
    parseGraphqlTimeline,
    parseTweetArticle,
    searchTweets,
    extractStatusId,
  }

  globalThis.XScopeCore = api
  if (typeof module !== "undefined" && module.exports) module.exports = api
})()
