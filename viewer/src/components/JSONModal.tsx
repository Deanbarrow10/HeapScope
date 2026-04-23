import { useEffect } from 'react';
import type { LeakReport } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  report: LeakReport | null;
}

function syntaxHighlight(obj: unknown): string {
  let json = JSON.stringify(obj, null, 2);
  json = json.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
  return json
    .replace(/"([^"\\]|\\.)*"(\s*:)?/g, (m, _g1, colon) =>
      colon ? `<span class="k">${m}</span>` : `<span class="s">${m}</span>`
    )
    .replace(/\b(true|false|null)\b/g, '<span class="b">$1</span>')
    .replace(/\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g, '<span class="n">$1</span>');
}

export default function JSONModal({ open, onClose, report }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const body = report ? syntaxHighlight(report) : '(no report loaded)';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="m-head">
          <span className="t">Raw report</span>
          <span className="m">leaks.json</span>
          <button className="x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <pre dangerouslySetInnerHTML={{ __html: body }} />
      </div>
    </div>
  );
}
