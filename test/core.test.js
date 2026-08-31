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
