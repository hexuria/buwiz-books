/**
 * Comments API Server Functions
 * Polymorphic CRUD for comments on any entity type
 */
import { createServerFn } from "@tanstack/react-start";
import { comments } from "../../db/schema/comments";
import { user, member } from "../../db/schema/auth";
import { eq, and, isNull, asc, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  generateR2Key,
  uploadToR2,
  getPresignedDownloadUrl,
  isR2Configured,
} from "../../lib/storage";
import { documents } from "../../db/schema/documents";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";
import { roleHasPermission } from "../../lib/permission-policy";

// ============================================================================
// Schemas
// ============================================================================

const entityRefSchema = z.object({
  entityType: z.string().min(1),
  entityId: z.string().uuid(),
});

const createCommentSchema = entityRefSchema.extend({
  body: z.string().min(1).max(10000),
  parentId: z.string().uuid().optional(),
  mentions: z.array(z.object({ userId: z.string(), name: z.string() })).optional(),
  attachments: z
    .array(
      z.object({
        r2Key: z.string(),
        filename: z.string(),
        contentType: z.string(),
        sizeBytes: z.number(),
      }),
    )
    .max(3)
    .optional(),
});

const updateCommentSchema = z.object({
  id: z.string().uuid(),
  body: z.string().min(1).max(10000),
  mentions: z.array(z.object({ userId: z.string(), name: z.string() })).optional(),
});

const deleteCommentSchema = z.object({ id: z.string().uuid() });

// ============================================================================
// Types
// ============================================================================

export interface CommentItem {
  id: string;
  parentId: string | null;
  parentAuthorName: string | null;
  authorId: string;
  authorName: string;
  authorImage: string | null;
  body: string;
  mentions: { userId: string; name: string }[] | null;
  attachments: { r2Key: string; filename: string; contentType: string; sizeBytes: number }[] | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

function assertCommentAttachmentOrgKey(orgId: string, r2Key: string): void {
  if (!r2Key.startsWith(`${orgId}/`)) {
    throw new Error("Attachment does not belong to the active organization");
  }
}

// ============================================================================
// Endpoints
// ============================================================================

/**
 * List comments for an entity (with author info)
 */
export const listComments = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const parsed = entityRefSchema.parse(rawData);

      // Alias for parent comment's author (flat UI "replied to" badge)
      const parentComment = alias(comments, "parentComment");
      const parentUser = alias(user, "parentUser");

      const rows = await db
        .select({
          id: comments.id,
          parentId: comments.parentId,
          parentAuthorName: parentUser.name,
          authorId: comments.authorId,
          authorName: user.name,
          authorImage: user.image,
          body: comments.body,
          mentions: comments.mentions,
          attachments: comments.attachments,
          editedAt: comments.editedAt,
          deletedAt: comments.deletedAt,
          createdAt: comments.createdAt,
        })
        .from(comments)
        .leftJoin(user, eq(comments.authorId, user.id))
        .leftJoin(parentComment, eq(comments.parentId, parentComment.id))
        .leftJoin(parentUser, eq(parentComment.authorId, parentUser.id))
        .where(
          and(
            eq(comments.organizationId, orgId),
            eq(comments.entityType, parsed.entityType),
            eq(comments.entityId, parsed.entityId),
          ),
        )
        .orderBy(asc(comments.createdAt));

      return rows.map((r) => ({
        ...r,
        authorName: r.authorName ?? "Unknown",
        parentAuthorName: r.parentAuthorName ?? null,
        body: r.deletedAt ? "[deleted]" : r.body,
        mentions: (r.mentions ?? null) as CommentItem["mentions"],
        attachments: r.deletedAt ? null : ((r.attachments ?? null) as CommentItem["attachments"]),
        editedAt: r.editedAt?.toISOString() ?? null,
        deletedAt: r.deletedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })) satisfies CommentItem[];
    });
  },
);

/**
 * Create a new comment
 */
export const createComment = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "comment",
      "create",
      { routeKey: "comment:create", limit: 30, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const parsed = createCommentSchema.parse(rawData);

        // If reply, verify parent exists and belongs to same entity
        if (parsed.parentId) {
          const [parent] = await db
            .select({ id: comments.id })
            .from(comments)
            .where(
              and(
                eq(comments.id, parsed.parentId),
                eq(comments.entityType, parsed.entityType),
                eq(comments.entityId, parsed.entityId),
                eq(comments.organizationId, orgId),
                isNull(comments.deletedAt),
              ),
            )
            .limit(1);

          if (!parent) throw new Error("Parent comment not found");
        }

        const [created] = await db
          .insert(comments)
          .values({
            organizationId: orgId,
            entityType: parsed.entityType,
            entityId: parsed.entityId,
            parentId: parsed.parentId ?? null,
            authorId: userId,
            body: parsed.body,
            mentions: parsed.mentions ?? null,
            attachments: parsed.attachments ?? null,
          })
          .returning();

        // Fetch with author info for immediate return
        const [row] = await db
          .select({
            id: comments.id,
            parentId: comments.parentId,
            authorId: comments.authorId,
            authorName: user.name,
            authorImage: user.image,
            body: comments.body,
            mentions: comments.mentions,
            attachments: comments.attachments,
            editedAt: comments.editedAt,
            deletedAt: comments.deletedAt,
            createdAt: comments.createdAt,
          })
          .from(comments)
          .leftJoin(user, eq(comments.authorId, user.id))
          .where(eq(comments.id, created.id))
          .limit(1);

        return {
          ...row,
          authorName: row.authorName ?? "Unknown",
          parentAuthorName: null,
          mentions: (row.mentions ?? null) as CommentItem["mentions"],
          attachments: (row.attachments ?? null) as CommentItem["attachments"],
          editedAt: row.editedAt?.toISOString() ?? null,
          deletedAt: null,
          createdAt: row.createdAt.toISOString(),
        } satisfies CommentItem;
      },
    );
  },
);

/**
 * Update a comment (author only)
 */
export const updateComment = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "comment",
      "edit",
      { routeKey: "comment:update", limit: 45, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const parsed = updateCommentSchema.parse(rawData);

        // Verify ownership — only the author can edit their comment
        const [existing] = await db
          .select({ authorId: comments.authorId })
          .from(comments)
          .where(
            and(
              eq(comments.id, parsed.id),
              eq(comments.organizationId, orgId),
              isNull(comments.deletedAt),
            ),
          )
          .limit(1);

        if (!existing) throw new Error("Comment not found");
        if (existing.authorId !== userId) throw new Error("Only the author can edit this comment");

        await db
          .update(comments)
          .set({
            body: parsed.body,
            mentions: parsed.mentions ?? null,
            editedAt: new Date(),
          })
          .where(eq(comments.id, parsed.id));

        return { success: true };
      },
    );
  },
);

/**
 * Soft-delete a comment.
 * Authors can delete their own (requires comment:delete).
 * Admins/owners can delete anyone's (requires comment:moderate).
 * Deleting a parent cascades soft-delete to all descendant replies.
 */
export const deleteComment = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "comment",
      "delete",
      { routeKey: "comment:delete", limit: 20, windowMs: 60_000 },
      async ({ orgId, userId, role, db }) => {
        const parsed = deleteCommentSchema.parse(rawData);

        const [existing] = await db
          .select({ authorId: comments.authorId })
          .from(comments)
          .where(
            and(
              eq(comments.id, parsed.id),
              eq(comments.organizationId, orgId),
              isNull(comments.deletedAt),
            ),
          )
          .limit(1);

        if (!existing) throw new Error("Comment not found");

        const isAuthor = existing.authorId === userId;
        if (!isAuthor) {
          // Non-author deletion is moderation — evaluate the real permission
          // statement rather than an inline role list that drifts from it.
          if (!roleHasPermission(role, "comment", "moderate")) {
            throw new Error("Not authorized to delete this comment");
          }
        }

        // Collect all descendant comment IDs for cascade soft-delete
        const idsToDelete = [parsed.id];
        const queue = [parsed.id];

        while (queue.length > 0) {
          const parentIds = queue.splice(0, queue.length);
          const children = await db
            .select({ id: comments.id })
            .from(comments)
            .where(
              and(
                inArray(comments.parentId, parentIds),
                eq(comments.organizationId, orgId),
                isNull(comments.deletedAt),
              ),
            );
          for (const child of children) {
            idsToDelete.push(child.id);
            queue.push(child.id);
          }
        }

        // Soft-delete parent + all descendants in one UPDATE
        const now = new Date();
        await db
          .update(comments)
          .set({ deletedAt: now })
          .where(and(inArray(comments.id, idsToDelete), eq(comments.organizationId, orgId)));

        return { success: true, deletedCount: idsToDelete.length };
      },
    );
  },
);

/**
 * Get org members for @mention autocomplete
 */
export const getOrgMembers = createServerFn({ method: "GET" }).handler(async () => {
  return withSessionOrgContext(async ({ orgId, db }) => {
    const rows = await db
      .select({
        userId: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
      })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(eq(member.organizationId, orgId))
      .orderBy(asc(user.name));

    return rows;
  });
});

/**
 * Upload a comment attachment (server-proxied to R2, avoids CORS issues)
 */
const MAX_BASE64_SIZE = Math.ceil(10 * 1024 * 1024 * 1.4); // ~10 MB file → ~14 MB base64

const commentUploadSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  fileBase64: z.string().min(1).max(MAX_BASE64_SIZE, "File exceeds maximum allowed size"),
});

export const uploadCommentFile = createServerFn({
  method: "POST",
}).handler(async ({ data: rawData }: { data: unknown }) => {
  return withMutationPermissionOrgContext(
    "comment",
    "create",
    { routeKey: "comment:upload", limit: 15, windowMs: 60_000 },
    async ({ orgId }) => {
      const parsed = commentUploadSchema.parse(rawData);

      if (!isR2Configured()) {
        throw new Error("File storage is not configured");
      }

      const fileBuffer = Buffer.from(parsed.fileBase64, "base64");

      const r2Key = generateR2Key(orgId, `comments/${parsed.filename}`);
      await uploadToR2(r2Key, fileBuffer, parsed.contentType);

      return {
        r2Key,
        filename: parsed.filename,
        contentType: parsed.contentType,
        sizeBytes: fileBuffer.length,
      };
    },
  );
});

/**
 * Get a presigned download URL for a single comment attachment
 * Requires authenticated user in the same org
 */
export const getCommentAttachmentUrl = createServerFn({
  method: "GET",
}).handler(async ({ data: rawData }: { data: unknown }) => {
  return withSessionOrgContext(async ({ orgId }) => {
    const parsed = z.object({ r2Key: z.string().min(1) }).parse(rawData);

    if (!isR2Configured()) {
      throw new Error("File storage is not configured");
    }

    assertCommentAttachmentOrgKey(orgId, parsed.r2Key);
    const url = await getPresignedDownloadUrl(parsed.r2Key, { expiresIn: 3600 });
    return { url };
  });
});

/**
 * Batch resolve presigned download URLs for comment attachments
 * Returns a map of r2Key -> presignedUrl
 */
export const getCommentAttachmentUrls = createServerFn({
  method: "POST",
}).handler(async ({ data: rawData }: { data: unknown }) => {
  return withSessionOrgContext(async ({ orgId }) => {
    const parsed = z.object({ r2Keys: z.array(z.string()).max(50) }).parse(rawData);

    if (!isR2Configured() || parsed.r2Keys.length === 0) {
      return { urls: {} as Record<string, string> };
    }

    const urls: Record<string, string> = {};
    await Promise.all(
      parsed.r2Keys.map(async (key) => {
        try {
          assertCommentAttachmentOrgKey(orgId, key);
          urls[key] = await getPresignedDownloadUrl(key, { expiresIn: 3600 });
        } catch {
          // Skip keys that fail (orphaned, deleted, etc.)
        }
      }),
    );

    return { urls };
  });
});

/**
 * Link an existing document from the document library as a comment attachment.
 * Returns the attachment data to be included in the comment's JSONB.
 */
export const attachExistingDocument = createServerFn({
  method: "POST",
}).handler(async ({ data: rawData }: { data: unknown }) => {
  return withMutationPermissionOrgContext(
    "comment",
    "create",
    { routeKey: "comment:attach-document", limit: 30, windowMs: 60_000 },
    async ({ orgId, db }) => {
      const parsed = z.object({ documentId: z.string().uuid() }).parse(rawData);

      const [doc] = await db
        .select({
          id: documents.id,
          r2Key: documents.r2Key,
          originalFilename: documents.originalFilename,
          mimeType: documents.mimeType,
          fileSizeBytes: documents.fileSizeBytes,
          thumbnailR2Key: documents.thumbnailR2Key,
        })
        .from(documents)
        .where(and(eq(documents.id, parsed.documentId), eq(documents.organizationId, orgId)))
        .limit(1);

      if (!doc || !doc.r2Key) {
        throw new Error("Document not found or has no file");
      }

      return {
        r2Key: doc.r2Key,
        filename: doc.originalFilename,
        contentType: doc.mimeType ?? "application/octet-stream",
        sizeBytes: doc.fileSizeBytes ?? 0,
        thumbnailR2Key: doc.thumbnailR2Key ?? undefined,
        documentId: doc.id,
      };
    },
  );
});
