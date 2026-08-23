/**
 * useChatAttachments.ts
 * WSD-Pro — Shared file-attachment staging for chat surfaces (Agents, project Chat).
 * Reads images as data URLs and text files inline; binary files travel name-only.
 */
import { useState, useRef } from 'preact/hooks';
import type { Attachment } from './useChatSocket';

export const MAX_ATTACHMENTS = 5;
export const MAX_TEXT_FILE_CHARS = 100000;
const TEXT_EXT = /\.(txt|md|markdown|json|js|jsx|ts|tsx|py|html?|css|scss|xml|ya?ml|toml|ini|cfg|sh|bash|zsh|fish|c|cc|cpp|h|hpp|java|go|rs|rb|php|sql|csv|log|env|gitignore)$/i;

export interface PendingFile {
  id: string;
  file: File;
  name: string;
  size: number;
  type: string;
  data: string | null;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isTextLike(name: string, type: string): boolean {
  return type.startsWith('text/') || TEXT_EXT.test(name);
}

export function useChatAttachments() {
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const addFiles = (fileList: FileList | null) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setError(null);
    const room = MAX_ATTACHMENTS - pending.length;
    if (files.length > room) setError(`Max ${MAX_ATTACHMENTS} attachments per message`);
    const added = files.slice(0, Math.max(room, 0));
    const items: PendingFile[] = added.map((f) => ({
      id: `${f.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      file: f,
      name: f.name,
      size: f.size,
      type: f.type,
      data: null,
    }));
    setPending((cur) => [...cur, ...items]);
    for (const it of items) {
      if (it.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onerror = () => {
          setPending((cur) => cur.filter((x) => x.id !== it.id));
          setError(`Failed to read ${it.name}`);
        };
        reader.onload = () => {
          setPending((cur) => cur.map((x) => (x.id === it.id ? { ...x, data: String(reader.result || '') } : x)));
        };
        reader.readAsDataURL(it.file);
      }
    }
  };

  const removeFile = (id: string) => setPending((cur) => cur.filter((x) => x.id !== id));
  const clear = () => setPending([]);

  async function toAttachment(p: PendingFile): Promise<Attachment> {
    if (p.type.startsWith('image/')) {
      const data = p.data || (await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.readAsDataURL(p.file);
      }));
      return { kind: 'image', name: p.name, data, size: p.size };
    }
    if (isTextLike(p.name, p.type)) {
      if (p.size > MAX_TEXT_FILE_CHARS) return { kind: 'file', name: p.name, size: p.size };
      const text = await p.file.text();
      return { kind: 'text', name: p.name, text, size: text.length };
    }
    return { kind: 'file', name: p.name, size: p.size };
  }

  /** Convert all staged files to wire attachments; returns null on failure. */
  async function buildAttachments(): Promise<Attachment[] | null> {
    if (pending.length === 0) return [];
    setReading(true);
    try {
      return await Promise.all(pending.map(toAttachment));
    } catch (err: any) {
      setError(err?.message || 'Failed to read attachment');
      return null;
    } finally {
      setReading(false);
    }
  }

  return { pending, reading, error, setError, addFiles, removeFile, clear, buildAttachments, fileRef };
}
