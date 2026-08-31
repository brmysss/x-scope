const test = require("node:test")
const assert = require("node:assert/strict")
const core = require("../src/core.js")

test("parses X metric formats", () => {
  assert.equal(core.parseMetric("115 Likes"), 115)
  assert.equal(core.parseMetric("1.2K views"), 1_200)
  assert.equal(core.parseMetric("2.5万"), 25_000)
  assert.equal(core.parseMetric("3亿"), 300_000_000)
  assert.equal(core.parseMetric("no metric"), null)
})

test("formats metrics for the sidebar", () => {
  assert.equal(core.formatMetric(115), "115")
  assert.equal(core.formatMetric(1_200), "1.2k")
  assert.equal(core.formatMetric(25_000), "2.5万")
  assert.equal(core.formatMetric(300_000_000), "3亿")
})

test("extracts status IDs and profile handles", () => {
  assert.equal(core.extractStatusId("https://x.com/example/status/123456789?s=20"), "123456789")
  assert.deepEqual(core.parseProfileFromPath("/OpenAI/with_replies"), {
    handle: "OpenAI",
    isTweetDetail: false,
  })
  assert.deepEqual(core.parseProfileFromPath("/OpenAI/status/123"), {
    handle: "OpenAI",
    isTweetDetail: true,
  })
  assert.equal(core.parseProfileFromPath("/home"), null)
  assert.equal(core.parseProfileFromPath("/search?q=x"), null)
})

test("builds X search queries and recognizes from-user search pages", () => {
  assert.equal(core.buildXSearchQuery("@Example", "115"), "from:Example 115")
  assert.equal(core.buildXSearchQuery("Example", 'from:Someone "直充"'), 'from:Example "直充"')
  assert.equal(
    core.buildXSearchUrl("Example", "115").startsWith("https://x.com/search?q=from%3AExample+115"),
    true,
  )
  assert.deepEqual(core.parseSearchContext("/search", "?q=from%3AExample%20115&f=live"), {
    handle: "Example",
    query: "from:Example 115",
  })
  assert.equal(core.extractSearchText("from:Example 115 since:2024-01-01"), "115")
})

test("merges duplicate tweets and keeps the newer metrics", () => {
  const merged = core.mergeTweets(
    [{ id: "1", text: "old", likes: 2 }],
    [
      { id: "1", text: "old", likes: 8 },
      { id: "2", text: "new", likes: 3 },
    ],
  )

  assert.equal(merged.length, 2)
  assert.equal(merged.find((tweet) => tweet.id === "1").likes, 8)
})

test("ranks original tweets by a selected metric", () => {
  const tweets = [
    { id: "1", likes: 20, replies: 3, isReply: false, isRetweet: false, createdAt: "2026-01-01" },
    { id: "2", likes: 90, replies: 1, isReply: true, isRetweet: false, createdAt: "2026-01-02" },
    { id: "3", likes: 50, replies: 8, isReply: false, isRetweet: false, createdAt: "2026-01-03" },
  ]

  assert.deepEqual(
    core.getTopTweets(tweets, "likes", 10, true).map((tweet) => tweet.id),
    ["3", "1"],
  )
  assert.deepEqual(
    core.getTopTweets(tweets, "replies", 2, false).map((tweet) => tweet.id),
    ["3", "1"],
  )
})

test("parses GraphQL timeline tweets, long text, metrics and cursors", () => {
  const payload = {
    data: {
      user: {
        result: {
          timeline_v2: {
            timeline: {
              instructions: [
                {
                  type: "TimelineAddEntries",
                  entries: [
                    {
                      entryId: "tweet-101",
                      content: {
                        itemContent: {
                          tweet_results: {
                            result: {
                              rest_id: "101",
                              core: {
                                user_results: {
                                  result: { legacy: { screen_name: "Example" } },
                                },
                              },
                              legacy: {
                                full_text: "short text",
                                created_at: "Mon Jan 01 00:00:00 +0000 2026",
                                favorite_count: 115,
                                reply_count: 8,
                                retweet_count: 12,
                                quote_count: 2,
                              },
                              note_tweet: {
                                note_tweet_results: { result: { text: "long form text" } },
                              },
                              views: { count: "2400" },
                            },
                          },
                        },
                      },
                    },
                    {
                      entryId: "cursor-bottom-abc",
                      content: { value: "cursor-abc" },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  }

  const parsed = core.parseGraphqlTimeline(payload, "Example")
  assert.equal(parsed.nextCursor, "cursor-abc")
  assert.equal(parsed.tweets.length, 1)
  assert.deepEqual(
    {
      ...parsed.tweets[0],
      capturedAt: undefined,
    },
    {
      id: "101",
      url: "https://x.com/Example/status/101",
      text: "long form text",
      author: "@Example",
      createdAt: "Mon Jan 01 00:00:00 +0000 2026",
      likes: 115,
      replies: 8,
      reposts: 12,
      quotes: 2,
      views: 2400,
      isRetweet: false,
      isReply: false,
      hasMedia: false,
      source: "graphql",
      capturedAt: undefined,
    },
  )
})

test("searches cached tweets with AND and OR terms before ranking", () => {
  const tweets = [
    { id: "1", text: "115 元直充", likes: 12, isReply: false, isRetweet: false },
    { id: "2", text: "直充活动", likes: 30, isReply: false, isRetweet: false },
    { id: "3", text: "其他内容", likes: 90, isReply: false, isRetweet: false },
  ]

  assert.deepEqual(core.searchTweets(tweets, "115 直充", "likes", 10, true).map((tweet) => tweet.id), ["1"])
  assert.deepEqual(core.searchTweets(tweets, "115 OR 活动", "likes", 10, true).map((tweet) => tweet.id), ["2", "1"])
})
