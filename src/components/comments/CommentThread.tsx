/**
 * CommentThread — Reusable polymorphic comment component
 *
 * Drop-in component for any entity type (reconciliation, transaction, bill, etc.)
 * Features: @mentions, link detection, YouTube embeds, file attachments,
 *           threaded replies, edit/delete, optimistic updates
 */
import React, { Fragment, useState, useRef, useEffect, useCallback, type FC } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSession } from "../../lib/auth-client";
import { useRole } from "../../lib/use-permission";
import {
  listComments,
  createComment,
  updateComment,
  deleteComment,
  getOrgMembers,
  uploadCommentFile,
  getCommentAttachmentUrls,
  attachExistingDocument,
} from "../../routes/api/-comments";
import type { CommentItem } from "../../routes/api/-comments";
import { FileTypeIcon } from "../documents/DocumentUploadModal";
import { listDocuments } from "../../routes/api/-documents";
import { createLogger } from "../../lib/logger";
const logger = createLogger("ui.comments");

// ============================================================================
// Types
// ============================================================================

type ServerFnCaller = (opts: { data: unknown }) => Promise<any>;

interface CommentThreadProps {
  entityType: string;
  entityId: string;
  isReadOnly?: boolean;
}

interface OrgMember {
  userId: string;
  name: string;
  email: string;
  image: string | null;
}

interface Attachment {
  r2Key: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  thumbnailR2Key?: string;
  documentId?: string;
}

// ============================================================================
// URL / Embed detection
// ============================================================================

const URL_REGEX = /(https?:\/\/[^\s<]+)/g;
const YOUTUBE_REGEX =
  /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
const VIMEO_REGEX = /vimeo\.com\/(?:video\/)?([0-9]+)/;

function extractYouTubeId(url: string): string | null {
  const m = url.match(YOUTUBE_REGEX);
  return m ? m[1] : null;
}

function extractVimeoId(url: string): string | null {
  const m = url.match(VIMEO_REGEX);
  return m ? m[1] : null;
}

// ============================================================================
// Helpers
// ============================================================================

function timeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(isoString).toLocaleDateString();
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

const AVATAR_COLORS = [
  "bg-emerald-500",
  "bg-blue-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-cyan-500",
  "bg-teal-500",
  "bg-indigo-500",
];

function avatarColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash << 5) - hash + id.charCodeAt(i);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================================================
// Rich Body Renderer
// ============================================================================

function RichBody({ body, mentions }: { body: string; mentions: CommentItem["mentions"] }) {
  // Replace @mention tokens with styled spans, linkify URLs, embed YT/Vimeo
  const parts: (string | React.ReactNode)[] = [];
  let lastIndex = 0;
  const ytEmbeds: string[] = [];
  const vimeoEmbeds: string[] = [];

  // Find all URLs
  const urlMatches = [...body.matchAll(URL_REGEX)];

  for (const match of urlMatches) {
    const idx = match.index!;
    if (idx > lastIndex) {
      parts.push(renderMentions(body.slice(lastIndex, idx), mentions));
    }

    const url = match[1];
    const ytId = extractYouTubeId(url);
    const vimeoId = extractVimeoId(url);
    if (ytId) {
      ytEmbeds.push(ytId);
      parts.push(
        <a
          key={`url-${idx}`}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-500 hover:underline break-all"
        >
          ▶ YouTube
        </a>,
      );
    } else if (vimeoId) {
      vimeoEmbeds.push(vimeoId);
      parts.push(
        <a
          key={`url-${idx}`}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-500 hover:underline break-all"
        >
          ▶ Vimeo
        </a>,
      );
    } else {
      parts.push(
        <a
          key={`url-${idx}`}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-500 hover:underline break-all"
        >
          {url.length > 60 ? `${url.slice(0, 57)}…` : url}
        </a>,
      );
    }
    lastIndex = idx + url.length;
  }

  if (lastIndex < body.length) {
    parts.push(renderMentions(body.slice(lastIndex), mentions));
  }

  return (
    <div>
      <div className="text-[12px] text-gray-700 dark:text-white/70 whitespace-pre-wrap break-words leading-relaxed">
        {parts}
      </div>
      {/* YouTube embeds */}
      {ytEmbeds.map((ytId) => (
        <div
          key={ytId}
          className="mt-2 rounded-lg overflow-hidden"
          style={{ aspectRatio: "16/9", maxWidth: 320 }}
        >
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${ytId}`}
            title="YouTube video"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            className="w-full h-full border-0"
          />
        </div>
      ))}
      {/* Vimeo embeds */}
      {vimeoEmbeds.map((vId) => (
        <div
          key={vId}
          className="mt-2 rounded-lg overflow-hidden"
          style={{ aspectRatio: "16/9", maxWidth: 320 }}
        >
          <iframe
            src={`https://player.vimeo.com/video/${vId}?dnt=1`}
            title="Vimeo video"
            allow="autoplay; fullscreen; picture-in-picture"
            allowFullScreen
            className="w-full h-full border-0"
          />
        </div>
      ))}
    </div>
  );
}

function renderMentions(text: string, mentions: CommentItem["mentions"]): React.ReactNode {
  if (!mentions?.length) return text;

  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  for (const m of mentions) {
    const token = `@${m.name}`;
    const idx = remaining.indexOf(token);
    if (idx === -1) continue;
    if (idx > 0) parts.push(<Fragment key={`t-${key++}`}>{remaining.slice(0, idx)}</Fragment>);
    parts.push(
      <span
        key={`m-${key++}`}
        className="inline-block px-1 py-0.5 rounded bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 text-[11px] font-semibold"
      >
        @{m.name}
      </span>,
    );
    remaining = remaining.slice(idx + token.length);
  }

  if (remaining) parts.push(<Fragment key={`t-${key++}`}>{remaining}</Fragment>);
  return <>{parts}</>;
}

// ============================================================================
// Attachment Previews (rich thumbnails – matches /documents page style)
// ============================================================================

function AttachmentList({ attachments }: { attachments: CommentItem["attachments"] }) {
  if (!attachments?.length) return null;

  // Batch-resolve presigned URLs for all attachment r2Keys
  const r2Keys = attachments.map((a) => a.r2Key);
  const { data: urlData } = useQuery({
    queryKey: ["commentAttachmentUrls", ...r2Keys],
    queryFn: () =>
      (getCommentAttachmentUrls as ServerFnCaller)({
        data: { r2Keys },
      }) as Promise<{ urls: Record<string, string> }>,
    staleTime: 50 * 60 * 1000, // 50 min (urls expire in 60 min)
    enabled: r2Keys.length > 0,
  });
  const urls = urlData?.urls ?? {};

  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {attachments.map((a) => {
        const ext = a.filename.split(".").pop()?.toLowerCase() ?? "";
        const isImage = a.contentType.startsWith("image/");
        const isVideo = a.contentType.startsWith("video/");
        const downloadUrl = urls[a.r2Key];

        return (
          <a
            key={a.r2Key}
            href={downloadUrl ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex flex-col rounded-lg border border-gray-100 dark:border-white/5 bg-gray-50 dark:bg-white/[0.03] overflow-hidden hover:border-emerald-300 dark:hover:border-emerald-500/30 transition-all cursor-pointer"
            style={{ width: 140 }}
            title={`${a.filename} (${formatBytes(a.sizeBytes)})`}
            onClick={(e) => {
              if (!downloadUrl) e.preventDefault();
            }}
          >
            {/* Preview area */}
            <div className="w-full aspect-[4/3] flex items-center justify-center bg-gray-100 dark:bg-white/[0.04] overflow-hidden relative">
              {isImage && downloadUrl ? (
                <img
                  src={downloadUrl}
                  alt={a.filename}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              ) : isVideo ? (
                <div className="flex flex-col items-center gap-1">
                  <div className="w-8 h-8 rounded-full bg-gray-700/60 flex items-center justify-center">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                  </div>
                  <FileTypeIcon fileType={ext || "mp4"} size={20} />
                </div>
              ) : (
                <FileTypeIcon fileType={ext || "other"} size={40} />
              )}
            </div>
            {/* File info */}
            <div className="px-2 py-1.5 flex items-center gap-1.5 min-w-0">
              <FileTypeIcon fileType={ext || "other"} size={16} />
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-medium text-gray-700 dark:text-white/60 truncate leading-tight">
                  {a.filename}
                </p>
                <p className="text-[9px] text-gray-400 dark:text-white/25">
                  {formatBytes(a.sizeBytes)}
                </p>
              </div>
            </div>
          </a>
        );
      })}
    </div>
  );
}

// ============================================================================
// Mention Dropdown
// ============================================================================

function MentionDropdown({
  members,
  query,
  selectedIndex,
  onSelect,
}: {
  members: OrgMember[];
  query: string;
  selectedIndex: number;
  onSelect: (member: OrgMember) => void;
}) {
  const filtered = members.filter(
    (m) =>
      m.name.toLowerCase().includes(query.toLowerCase()) ||
      m.email.toLowerCase().includes(query.toLowerCase()),
  );

  if (filtered.length === 0) return null;

  return (
    <div className="absolute z-50 left-0 right-0 bottom-full mb-1 bg-white dark:bg-[#1a2332] rounded-lg shadow-xl border border-gray-200 dark:border-white/10 overflow-hidden">
      <div className="max-h-40 overflow-y-auto">
        {filtered.slice(0, 8).map((m, i) => (
          <button
            key={m.userId}
            type="button"
            onClick={() => onSelect(m)}
            className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${
              i === selectedIndex
                ? "bg-emerald-50 dark:bg-emerald-500/10"
                : "hover:bg-gray-50 dark:hover:bg-white/5"
            }`}
          >
            <div
              className={`w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold text-white ${avatarColor(m.userId)}`}
            >
              {m.image ? (
                <img src={m.image} alt="" className="w-6 h-6 rounded-full object-cover" />
              ) : (
                getInitials(m.name)
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-medium text-gray-700 dark:text-white/70 truncate">
                {m.name}
              </div>
              <div className="text-[10px] text-gray-400 dark:text-white/30 truncate">{m.email}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Get the list of filtered members for dropdown keyboard nav */
function getFilteredMembers(members: OrgMember[], query: string): OrgMember[] {
  return members
    .filter(
      (m) =>
        m.name.toLowerCase().includes(query.toLowerCase()) ||
        m.email.toLowerCase().includes(query.toLowerCase()),
    )
    .slice(0, 8);
}

// ============================================================================
// Single Comment Row
// ============================================================================

function CommentRow({
  comment,
  currentUserId,
  canModerate,
  isReadOnly,
  onReply,
  onEdit,
  onDelete,
}: {
  comment: CommentItem;
  currentUserId: string;
  canModerate: boolean;
  isReadOnly: boolean;
  onReply: (parentId: string) => void;
  onEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
}) {
  const isDeleted = !!comment.deletedAt;
  const isAuthor = comment.authorId === currentUserId;
  const canEdit = isAuthor;
  const canDelete = isAuthor || canModerate;

  const handleDelete = useCallback(() => {
    const msg = isAuthor
      ? "Delete this comment? Replies will also be removed."
      : `Delete ${comment.authorName}'s comment? This is a moderation action. Replies will also be removed.`;
    if (window.confirm(msg)) {
      onDelete(comment.id);
    }
  }, [isAuthor, comment.authorName, comment.id, onDelete]);

  return (
    <div className="group">
      <div className="flex gap-2.5 py-2">
        {/* Avatar */}
        <div
          className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0 ${
            isDeleted ? "bg-gray-300 dark:bg-white/10" : avatarColor(comment.authorId)
          }`}
        >
          {comment.authorImage && !isDeleted ? (
            <img src={comment.authorImage} alt="" className="w-7 h-7 rounded-full object-cover" />
          ) : (
            getInitials(isDeleted ? "?" : comment.authorName)
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[12px] font-semibold text-gray-800 dark:text-white/80">
              {isDeleted ? "Deleted" : comment.authorName}
            </span>
            {/* Reply badge — shown inline instead of nesting */}
            {comment.parentAuthorName && !isDeleted && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-500/10 text-[9px] font-medium text-blue-500 dark:text-blue-400">
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <polyline points="9 14 4 9 9 4" />
                  <path d="M20 20v-7a4 4 0 00-4-4H4" />
                </svg>
                {comment.parentAuthorName}
              </span>
            )}
            <span className="text-[10px] text-gray-400 dark:text-white/25">
              {timeAgo(comment.createdAt)}
            </span>
            {comment.editedAt && !isDeleted && (
              <span className="text-[9px] text-gray-400 dark:text-white/20 italic">(edited)</span>
            )}
          </div>

          {isDeleted ? (
            <div className="text-[12px] text-gray-400 dark:text-white/20 italic mt-0.5">
              This comment was deleted.
            </div>
          ) : (
            <>
              <RichBody body={comment.body} mentions={comment.mentions} />
              <AttachmentList attachments={comment.attachments} />

              {/* Actions */}
              {!isReadOnly && (
                <div className="flex items-center gap-3 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    onClick={() => onReply(comment.id)}
                    className="text-[10px] font-medium text-gray-400 dark:text-white/30 hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
                  >
                    Reply
                  </button>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => onEdit(comment.id, comment.body)}
                      className="text-[10px] font-medium text-gray-400 dark:text-white/30 hover:text-amber-500 dark:hover:text-amber-400 transition-colors"
                    >
                      Edit
                    </button>
                  )}
                  {canDelete && (
                    <button
                      type="button"
                      onClick={handleDelete}
                      className="text-[10px] font-medium text-gray-400 dark:text-white/30 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                    >
                      Delete
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Comment Input — contentEditable with mention chips
// ============================================================================

/** Segment type for the input model */
type Segment = { type: "text"; value: string } | { type: "mention"; userId: string; name: string };

/** Serialize segments to a plain body string (for API) */
function segmentsToBody(segments: Segment[]): string {
  return segments.map((s) => (s.type === "mention" ? `@${s.name}` : s.value)).join("");
}

/** Extract mention list from segments */
function segmentsToMentions(segments: Segment[]): { userId: string; name: string }[] {
  const seen = new Set<string>();
  const result: { userId: string; name: string }[] = [];
  for (const s of segments) {
    if (s.type === "mention" && !seen.has(s.userId)) {
      seen.add(s.userId);
      result.push({ userId: s.userId, name: s.name });
    }
  }
  return result;
}

function CommentInput({
  entityType,
  entityId,
  parentId,
  editId,
  editBody,
  members,
  onSubmitted,
  onCancelReply,
  onCancelEdit,
}: {
  entityType: string;
  entityId: string;
  parentId: string | null;
  editId: string | null;
  editBody: string | null;
  members: OrgMember[];
  onSubmitted: () => void;
  onCancelReply: () => void;
  onCancelEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [hasContent, setHasContent] = useState(false);
  const [docBrowserOpen, setDocBrowserOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const inputRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Track whether we should skip the next DOM sync (because user is typing)
  const skipSyncRef = useRef(false);
  // Internal segments state
  const segmentsRef = useRef<Segment[]>([{ type: "text", value: "" }]);

  // When editing, set initial content
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;

    if (editBody !== null) {
      el.textContent = editBody;
      segmentsRef.current = [{ type: "text", value: editBody }];
      setHasContent(editBody.trim().length > 0);
      setTimeout(() => {
        el.focus();
        const range = document.createRange();
        const sel = window.getSelection();
        range.selectNodeContents(el);
        range.collapse(false);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }, 0);
    } else {
      el.innerHTML = "";
      segmentsRef.current = [{ type: "text", value: "" }];
      setHasContent(false);
    }
  }, [editBody, editId]);

  // Focus when replying
  useEffect(() => {
    if (parentId) inputRef.current?.focus();
  }, [parentId]);

  /** Read segments from the contentEditable DOM */
  const readSegmentsFromDOM = useCallback((): Segment[] => {
    const el = inputRef.current;
    if (!el) return [{ type: "text", value: "" }];

    const segs: Segment[] = [];
    el.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        segs.push({ type: "text", value: node.textContent ?? "" });
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const elem = node as HTMLElement;
        const userId = elem.getAttribute("data-mention-id");
        const name = elem.getAttribute("data-mention-name");
        if (userId && name) {
          segs.push({ type: "mention", userId, name });
        } else if (elem.tagName === "BR") {
          segs.push({ type: "text", value: "\n" });
        } else {
          segs.push({ type: "text", value: elem.textContent ?? "" });
        }
      }
    });

    if (segs.length === 0) segs.push({ type: "text", value: "" });
    return segs;
  }, []);

  const createMutation = useMutation({
    mutationFn: (data: {
      entityType: string;
      entityId: string;
      body: string;
      parentId?: string;
      mentions?: { userId: string; name: string }[];
      attachments?: Attachment[];
    }) => (createComment as ServerFnCaller)({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["comments", entityType, entityId],
      });
      clearInput();
      setAttachments([]);
      onSubmitted();
    },
  });

  const editMutation = useMutation({
    mutationFn: (data: {
      id: string;
      body: string;
      mentions?: { userId: string; name: string }[];
    }) => (updateComment as ServerFnCaller)({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["comments", entityType, entityId],
      });
      clearInput();
      onCancelEdit();
    },
  });

  const clearInput = useCallback(() => {
    const el = inputRef.current;
    if (el) el.innerHTML = "";
    segmentsRef.current = [{ type: "text", value: "" }];
    setMentionQuery(null);
    setMentionIndex(0);
    setHasContent(false);
  }, []);

  const handleSubmit = useCallback(() => {
    const segs = readSegmentsFromDOM();
    const body = segmentsToBody(segs).trim();
    if (!body && attachments.length === 0) return;

    const mentionList = segmentsToMentions(segs);

    if (editId) {
      editMutation.mutate({
        id: editId,
        body,
        mentions: mentionList.length > 0 ? mentionList : undefined,
      });
    } else {
      createMutation.mutate({
        entityType,
        entityId,
        body,
        parentId: parentId ?? undefined,
        mentions: mentionList.length > 0 ? mentionList : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
    }
  }, [
    readSegmentsFromDOM,
    attachments,
    editId,
    entityType,
    entityId,
    parentId,
    editMutation,
    createMutation,
  ]);

  // ---- Mention logic ----
  const checkMentionTrigger = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) {
      setMentionQuery(null);
      return;
    }

    const text = node.textContent ?? "";
    const cursorPos = range.startOffset;
    const textBeforeCursor = text.slice(0, cursorPos);
    const atIdx = textBeforeCursor.lastIndexOf("@");

    if (atIdx >= 0 && (atIdx === 0 || /\s/.test(textBeforeCursor[atIdx - 1]))) {
      const query = textBeforeCursor.slice(atIdx + 1);
      if (!/\s/.test(query)) {
        setMentionQuery(query);
        setMentionIndex(0);
        return;
      }
    }
    setMentionQuery(null);
  }, []);

  const insertMentionChip = useCallback(
    (m: OrgMember) => {
      const el = inputRef.current;
      if (!el) return;

      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;

      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType !== Node.TEXT_NODE) return;

      const text = node.textContent ?? "";
      const cursorPos = range.startOffset;
      const textBefore = text.slice(0, cursorPos);
      const atIdx = textBefore.lastIndexOf("@");
      if (atIdx === -1) return;

      const before = text.slice(0, atIdx);
      const after = text.slice(cursorPos);

      // Create chip element
      const chip = document.createElement("span");
      chip.contentEditable = "false";
      chip.setAttribute("data-mention-id", m.userId);
      chip.setAttribute("data-mention-name", m.name);
      chip.className =
        "inline-flex items-center px-1.5 py-0.5 mx-0.5 rounded bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 text-[11px] font-medium cursor-default";
      chip.textContent = `@${m.name}`;

      // Replace the text node with: before text + chip + " " + after text
      const parent = node.parentNode;
      if (!parent) return;

      const frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));
      frag.appendChild(chip);
      const afterText = document.createTextNode(`\u00A0${after}`); // non-breaking space after chip
      frag.appendChild(afterText);

      parent.replaceChild(frag, node);

      // Place cursor after the space
      const newRange = document.createRange();
      newRange.setStart(afterText, 1); // After the space
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);

      // Update segments ref
      segmentsRef.current = readSegmentsFromDOM();
      setMentionQuery(null);
      setMentionIndex(0);
    },
    [readSegmentsFromDOM],
  );

  // ---- Keyboard handling ----
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Mention dropdown navigation
      if (mentionQuery !== null) {
        const filtered = getFilteredMembers(members, mentionQuery);

        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionIndex((prev) => (prev + 1) % Math.max(filtered.length, 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionIndex(
            (prev) => (prev - 1 + Math.max(filtered.length, 1)) % Math.max(filtered.length, 1),
          );
          return;
        }
        if ((e.key === "Tab" || e.key === "Enter") && filtered.length > 0) {
          e.preventDefault();
          insertMentionChip(filtered[mentionIndex] || filtered[0]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setMentionQuery(null);
          return;
        }
      }

      // ⌘+Enter or Ctrl+Enter to submit
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
        return;
      }

      // Plain Enter — submit
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
        return;
      }

      // Escape
      if (e.key === "Escape") {
        if (parentId) onCancelReply();
        else if (editId) onCancelEdit();
      }
    },
    [
      mentionQuery,
      members,
      mentionIndex,
      insertMentionChip,
      handleSubmit,
      parentId,
      editId,
      onCancelReply,
      onCancelEdit,
    ],
  );

  // ---- Input handler ----
  const handleInput = useCallback(() => {
    skipSyncRef.current = true;
    segmentsRef.current = readSegmentsFromDOM();
    checkMentionTrigger();
    // Update hasContent state so send button re-enables reactively
    const body = segmentsToBody(segmentsRef.current).trim();
    setHasContent(body.length > 0);
  }, [readSegmentsFromDOM, checkMentionTrigger]);

  // Handle paste — strip formatting
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, text);
  }, []);

  const handleFileUpload = async (files: FileList | null) => {
    if (!files?.length) return;
    const remaining = 3 - attachments.length;
    if (remaining <= 0) return;

    setUploading(true);
    try {
      for (let i = 0; i < Math.min(files.length, remaining); i++) {
        const file = files[i];
        if (file.size > 10 * 1024 * 1024) {
          logger.warn("File too large", { fileName: file.name, fileSize: file.size });
          continue;
        }

        const contentType = file.type || "application/octet-stream";

        // Read file as base64 for server-proxied upload (avoids R2 CORS issues)
        const fileBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result as string;
            resolve(result.split(",")[1]); // strip data:...;base64, prefix
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        const result = await (uploadCommentFile as ServerFnCaller)({
          data: { filename: file.name, contentType, fileBase64 },
        });

        setAttachments((prev) => [
          ...prev,
          {
            r2Key: result.r2Key,
            filename: result.filename,
            contentType: result.contentType,
            sizeBytes: result.sizeBytes,
          },
        ]);
      }
    } catch (err) {
      logger.error("Upload failed", { error: err });
    } finally {
      setUploading(false);
      // Reset file input so the same file can be selected again
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const isPending = createMutation.isPending || editMutation.isPending;
  const isEditing = editId !== null;

  return (
    <div className="p-3 border-t border-gray-100 dark:border-white/5 bg-white dark:bg-[#111820] relative">
      {/* Reply / Edit indicator */}
      {(parentId || isEditing) && (
        <div className="flex items-center gap-1.5 mb-1.5 text-[10px]">
          <span className="text-blue-500 font-medium">
            {isEditing ? "Editing comment" : "Replying…"}
          </span>
          <button
            type="button"
            onClick={isEditing ? onCancelEdit : onCancelReply}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-white/50"
          >
            ✕
          </button>
        </div>
      )}

      {/* Mention dropdown */}
      {mentionQuery !== null && (
        <MentionDropdown
          members={members}
          query={mentionQuery}
          selectedIndex={mentionIndex}
          onSelect={insertMentionChip}
        />
      )}

      {/* Pending attachments */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {attachments.map((a, i) => {
            const ext = a.filename.split(".").pop()?.toLowerCase() ?? "";
            const isImage = a.contentType.startsWith("image/");
            return (
              <div
                key={a.r2Key}
                className="group relative flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-gray-50 dark:bg-white/5 border border-gray-100 dark:border-white/5 text-[10px] text-gray-500 dark:text-white/40"
              >
                {isImage ? (
                  <div className="w-5 h-5 rounded overflow-hidden bg-gray-100 dark:bg-white/5 flex-shrink-0">
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="w-full h-full p-0.5"
                    >
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                  </div>
                ) : (
                  <FileTypeIcon fileType={ext || "other"} size={20} />
                )}
                <span className="truncate max-w-[90px] font-medium">{a.filename}</span>
                <span className="text-gray-400 dark:text-white/20">{formatBytes(a.sizeBytes)}</span>
                <button
                  type="button"
                  onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))}
                  className="ml-0.5 p-0.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex gap-2">
        {/* ContentEditable input with mention chips */}
        <div
          ref={inputRef}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          data-placeholder="Write a comment… (Enter to send)"
          className="flex-1 px-3 py-2 text-[12px] rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.03] text-gray-700 dark:text-white/70 resize-none focus:outline-none focus:ring-1 focus:ring-emerald-500/40 focus:border-emerald-500/40 min-h-[36px] max-h-[120px] overflow-y-auto whitespace-pre-wrap break-words empty:before:content-[attr(data-placeholder)] empty:before:text-gray-400 dark:empty:before:text-white/20 empty:before:pointer-events-none"
        />
        <div className="flex flex-col gap-1 self-end">
          {/* Upload button */}
          {!isEditing && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => handleFileUpload(e.target.files)}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || attachments.length >= 3}
                className="w-8 h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-lg bg-gray-100 dark:bg-white/5 flex items-center justify-center text-gray-400 dark:text-white/30 hover:text-gray-600 dark:hover:text-white/50 disabled:opacity-30 transition-colors"
                title="Attach file (max 10MB, 3 files)"
              >
                {uploading ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" className="animate-spin">
                    <circle
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="2"
                      fill="none"
                      opacity="0.3"
                    />
                    <path
                      d="M12 2a10 10 0 019.95 9"
                      stroke="currentColor"
                      strokeWidth="2"
                      fill="none"
                    />
                  </svg>
                ) : (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                  </svg>
                )}
              </button>
              {/* Browse Documents button */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setDocBrowserOpen((v) => !v)}
                  disabled={attachments.length >= 3}
                  className="w-8 h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-lg bg-gray-100 dark:bg-white/5 flex items-center justify-center text-gray-400 dark:text-white/30 hover:text-gray-600 dark:hover:text-white/50 disabled:opacity-30 transition-colors"
                  title="Browse existing documents"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                </button>
                {docBrowserOpen && (
                  <DocumentBrowserPopover
                    onSelect={async (docId: string) => {
                      if (attachments.length >= 3) return;
                      try {
                        const result = await (attachExistingDocument as ServerFnCaller)({
                          data: { documentId: docId },
                        });
                        setAttachments((prev) => [
                          ...prev,
                          {
                            r2Key: result.r2Key,
                            filename: result.filename,
                            contentType: result.contentType,
                            sizeBytes: result.sizeBytes,
                            thumbnailR2Key: result.thumbnailR2Key,
                            documentId: result.documentId,
                          },
                        ]);
                      } catch (err) {
                        logger.error("Failed to attach document", { error: err });
                      }
                      setDocBrowserOpen(false);
                    }}
                    onClose={() => setDocBrowserOpen(false)}
                  />
                )}
              </div>
            </>
          )}
          {/* Send button */}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isPending || (!hasContent && attachments.length === 0)}
            className="w-8 h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-lg bg-emerald-600 text-white flex items-center justify-center hover:bg-emerald-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Document Browser Popover (link existing document)
// ============================================================================

function DocumentBrowserPopover({
  onSelect,
  onClose,
}: {
  onSelect: (documentId: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");

  const { data, isPending } = useQuery({
    queryKey: ["documents", "commentBrowser"],
    queryFn: () =>
      (listDocuments as ServerFnCaller)({
        data: { sortBy: "createdAt", sortOrder: "desc" },
      }) as Promise<{
        documents: {
          id: string;
          originalFilename: string;
          displayTitle: string | null;
          fileType: string;
          fileSizeBytes: number | null;
        }[];
      }>,
    staleTime: 60_000,
  });

  const docs = data?.documents ?? [];
  const filtered = search
    ? docs.filter(
        (d) =>
          d.originalFilename.toLowerCase().includes(search.toLowerCase()) ||
          d.displayTitle?.toLowerCase().includes(search.toLowerCase()),
      )
    : docs;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-10"
        onClick={onClose}
        onKeyDown={() => {}}
        role="presentation"
      />
      {/* Popover */}
      <div className="absolute bottom-full right-0 mb-2 w-64 max-h-72 bg-white dark:bg-[#1e293b] rounded-xl border border-gray-200 dark:border-white/10 shadow-xl z-20 flex flex-col overflow-hidden">
        {/* Search */}
        <div className="px-3 pt-3 pb-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search documents…"
            autoFocus
            className="w-full px-2.5 py-1.5 text-base sm:text-[11px] rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.03] text-gray-700 dark:text-white/70 placeholder:text-gray-400 dark:placeholder:text-white/20 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
          />
        </div>
        {/* Document list */}
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {isPending ? (
            <div className="flex items-center justify-center py-6">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                className="animate-spin text-gray-400"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="2"
                  fill="none"
                  opacity="0.3"
                />
                <path
                  d="M12 2a10 10 0 019.95 9"
                  stroke="currentColor"
                  strokeWidth="2"
                  fill="none"
                />
              </svg>
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-[11px] text-gray-400 dark:text-white/25 text-center py-6">
              {search ? "No matching documents" : "No documents uploaded yet"}
            </p>
          ) : (
            filtered.slice(0, 20).map((doc) => (
              <button
                key={doc.id}
                type="button"
                onClick={() => onSelect(doc.id)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
              >
                <FileTypeIcon fileType={doc.fileType} size={24} />
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-medium text-gray-700 dark:text-white/70 truncate">
                    {doc.displayTitle || doc.originalFilename}
                  </p>
                  <p className="text-[9px] text-gray-400 dark:text-white/25">
                    {doc.fileSizeBytes ? formatBytes(doc.fileSizeBytes) : "—"}
                  </p>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export const CommentThread: FC<CommentThreadProps> = ({
  entityType,
  entityId,
  isReadOnly = false,
}) => {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const listRef = useRef<HTMLDivElement>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState<string | null>(null);

  // Fetch comments
  const commentsQuery = useQuery({
    queryKey: ["comments", entityType, entityId],
    queryFn: () =>
      (listComments as ServerFnCaller)({
        data: { entityType, entityId },
      }),
    enabled: !!session?.user && !!entityId,
  });

  // Fetch org members for @mentions
  const membersQuery = useQuery({
    queryKey: ["org-members"],
    queryFn: () => (getOrgMembers as ServerFnCaller)({ data: {} }),
    enabled: !!session?.user,
    staleTime: 5 * 60 * 1000, // 5 min
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: (id: string) => (deleteComment as ServerFnCaller)({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["comments", entityType, entityId],
      });
    },
  });

  const allComments: CommentItem[] = commentsQuery.data ?? [];
  const members: OrgMember[] = membersQuery.data ?? [];
  const currentUserId = session?.user?.id ?? "";
  const { role } = useRole();
  const canModerate = role === "admin" || role === "owner";

  // Scroll to bottom on new comments
  const prevCount = useRef(allComments.length);
  useEffect(() => {
    if (allComments.length > prevCount.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    prevCount.current = allComments.length;
  }, [allComments.length]);

  const handleReply = useCallback((parentId: string) => {
    setReplyTo(parentId);
    setEditId(null);
    setEditBody(null);
  }, []);

  const handleEdit = useCallback((id: string, body: string) => {
    setEditId(id);
    setEditBody(body);
    setReplyTo(null);
  }, []);

  const handleDelete = useCallback(
    (id: string) => {
      deleteMutation.mutate(id);
    },
    [deleteMutation],
  );

  // Empty state
  if (allComments.length === 0 && !commentsQuery.isLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 flex flex-col items-center justify-center py-12 px-6 text-center">
          <div className="w-12 h-12 rounded-xl bg-gray-100 dark:bg-white/5 flex items-center justify-center mb-3">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="text-gray-300 dark:text-white/20"
            >
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </svg>
          </div>
          <div className="text-[13px] font-medium text-gray-500 dark:text-white/40">
            No comments yet
          </div>
          <div className="text-[11px] text-gray-400 dark:text-white/30 mt-1">
            Leave a comment to start a conversation
          </div>
        </div>

        {!isReadOnly && (
          <CommentInput
            entityType={entityType}
            entityId={entityId}
            parentId={null}
            editId={null}
            editBody={null}
            members={members}
            onSubmitted={() => {}}
            onCancelReply={() => {}}
            onCancelEdit={() => {}}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Flat comment list — all comments chronological, replies show badge */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-0">
        {allComments.map((c) => (
          <CommentRow
            key={c.id}
            comment={c}
            currentUserId={currentUserId}
            canModerate={canModerate}
            isReadOnly={isReadOnly}
            onReply={handleReply}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        ))}
      </div>

      {/* Input */}
      {!isReadOnly && (
        <CommentInput
          entityType={entityType}
          entityId={entityId}
          parentId={replyTo}
          editId={editId}
          editBody={editBody}
          members={members}
          onSubmitted={() => setReplyTo(null)}
          onCancelReply={() => setReplyTo(null)}
          onCancelEdit={() => {
            setEditId(null);
            setEditBody(null);
          }}
        />
      )}
    </div>
  );
};

export default CommentThread;
