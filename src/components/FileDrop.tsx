/* ============================================================================
   FileDrop — a drop zone that actually takes a file
   ----------------------------------------------------------------------------
   The client portal's "Send us your site plan" dialog had a drawing of one: a
   box that said "drag a file here" with no input behind it. This is the real
   thing: drag and drop, or a button that opens the file picker (a real
   <button>, so it works from the keyboard), the chosen file shown back with a
   way to change it, and the reason when a file is refused.
   ========================================================================== */

import { useRef, useState } from 'react';
import { Icon } from './Icon';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';

export function FileDrop({
  file,
  onFile,
  check,
  accept,
  hint,
}: {
  file: File | null;
  onFile: (f: File | null) => void;
  /** Returns why a file cannot be taken, or null. */
  check: (f: File) => string | null;
  accept?: string;
  hint: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const take = (f: File | undefined | null) => {
    if (!f) return;
    const bad = check(f);
    setError(bad);
    onFile(bad ? null : f);
  };

  const size = (n: number) =>
    n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

  return (
    <div>
      <div
        className="well p-5 text-center"
        style={over ? { borderColor: TONE_LINE.info, background: TONE_BG.info } : undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          take(e.dataTransfer.files?.[0]);
        }}
      >
        {file ? (
          <div className="flex items-center gap-3 text-left">
            <span style={{ color: TONE_HEX.info }}>
              <Icon name="fileText" decorative className="icon-lg" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] text-ink font-medium truncate">{file.name}</div>
              <div className="text-[12px] text-ink-3">{size(file.size)}</div>
            </div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => input.current?.click()}>
              Change
            </button>
          </div>
        ) : (
          <>
            <div className="text-ink-3 mb-2 flex justify-center">
              <Icon name="fileText" decorative className="icon-xl" />
            </div>
            <p className="text-[13px] text-ink-2">
              Drag a file here, or{' '}
              <button type="button" className="btn btn-secondary btn-sm ml-1" onClick={() => input.current?.click()}>
                choose a file
              </button>
            </p>
            <p className="text-[12px] text-ink-3 mt-2">{hint}</p>
          </>
        )}
        <input
          ref={input}
          type="file"
          hidden
          accept={accept}
          onChange={(e) => {
            take(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      {error ? (
        <p role="alert" className="text-[12.5px] text-status-critical mt-2">
          {error}
        </p>
      ) : null}
    </div>
  );
}
