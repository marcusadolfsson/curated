import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";

/** A post or reel someone shared into a DM thread. */
export const posts = sqliteTable(
  "posts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    // Identity of the shared media
    shortcode: text("shortcode").notNull().unique(),
    permalink: text("permalink").notNull(),
    mediaType: text("mediaType", { enum: ["post", "reel", "tv", "unknown"] })
      .notNull()
      .default("unknown"),
    mediaId: text("mediaId"),
    caption: text("caption"),
    authorUsername: text("authorUsername"),
    /** Anything the sender typed alongside the share ("we should make this"). */
    messageText: text("messageText"),

    // Thumbnail: remote URLs expire, so we keep a local copy and serve that.
    thumbnailUrl: text("thumbnailUrl"),
    thumbnailFile: text("thumbnailFile"),
    /** Every image in the post, fetched on demand. JSON array of {file,width,height}. */
    images: text("images"),
    /** The reel's own mp4, fetched on demand. */
    videoFile: text("videoFile"),

    // Where it came from
    threadId: text("threadId"),
    itemId: text("itemId"),
    /** The `mid.$...` id, which is what the reaction mutation addresses. */
    messageId: text("messageId"),
    senderId: text("senderId"),
    senderUsername: text("senderUsername"),
    /** Their profile picture, copied locally. Denormalised like the name. */
    senderAvatarFile: text("senderAvatarFile"),
    sharedAt: integer("sharedAt", { mode: "timestamp" }),

    /** The emoji the model picked for this post; what actually gets sent. */
    suggestedReaction: text("suggestedReaction"),

    // Reaction sent back to the sender, so they can see it landed
    reactedAt: integer("reactedAt", { mode: "timestamp" }),
    reactionEmoji: text("reactionEmoji"),
    reactionError: text("reactionError"),

    // What you said back, in the thread, quoting the share
    /** A reply the model drafted while reading the post; shown in the form, never sent on its own. */
    draftReply: text("draftReply"),
    replyText: text("replyText"),
    repliedAt: integer("repliedAt", { mode: "timestamp" }),

    // Triage state
    viewed: integer("viewed", { mode: "boolean" }).notNull().default(false),
    viewedAt: integer("viewedAt", { mode: "timestamp" }),
    /** Kept on purpose - the ones worth coming back to. */
    saved: integer("saved", { mode: "boolean" }).notNull().default(false),
    savedAt: integer("savedAt", { mode: "timestamp" }),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),

    // What the model made of it
    analysisStatus: text("analysisStatus", {
      enum: ["pending", "running", "done", "error"],
    })
      .notNull()
      .default("pending"),
    category: text("category"),
    summary: text("summary"),
    items: text("items"), // JSON array of strings
    /** How much the caption carried, once its packaging was stripped. */
    captionStrength: text("captionStrength"),
    /** The register of the summary. The emoji and the draft reply follow it. */
    sentiment: text("sentiment"),
    analysisModel: text("analysisModel"),
    analysisCostUsd: real("analysisCostUsd"),
    analysisError: text("analysisError"),
    analyzedAt: integer("analyzedAt", { mode: "timestamp" }),
  },
  (table) => [
    index("posts_sharedAt_idx").on(table.sharedAt),
    index("posts_analysisStatus_idx").on(table.analysisStatus),
  ],
);

/** DM threads discovered in the inbox; `watch` picks which ones sync imports from. */
export const threads = sqliteTable("threads", {
  threadId: text("threadId").primaryKey(),
  /** The FBID-style id the GraphQL mutations use; the API id will not do. */
  threadV2Id: text("threadV2Id"),
  /**
   * The id the web client puts in /direct/t/<id>/, which is what the reaction
   * mutation means by thread_id. It is NOT thread_v2_id - sending that gets a
   * cheerful 200 with a null response and no reaction.
   */
  threadFbid: text("threadFbid"),
  title: text("title"),
  participants: text("participants"), // JSON array of usernames
  watch: integer("watch", { mode: "boolean" }).notNull().default(false),
  lastItemAt: integer("lastItemAt", { mode: "timestamp" }),
  lastSyncedAt: integer("lastSyncedAt", { mode: "timestamp" }),
  postsFound: integer("postsFound").notNull().default(0),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: integer("updatedAt", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** One row per sync, so the UI can show what the last run actually did. */
export const syncRuns = sqliteTable("syncRuns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startedAt: integer("startedAt", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  finishedAt: integer("finishedAt", { mode: "timestamp" }),
  status: text("status", { enum: ["running", "done", "error"] })
    .notNull()
    .default("running"),
  threadsScanned: integer("threadsScanned").notNull().default(0),
  itemsScanned: integer("itemsScanned").notNull().default(0),
  postsAdded: integer("postsAdded").notNull().default(0),
  postsAnalyzed: integer("postsAnalyzed").notNull().default(0),
  error: text("error"),
});

export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
export type Thread = typeof threads.$inferSelect;
export type SyncRun = typeof syncRuns.$inferSelect;
