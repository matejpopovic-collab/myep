/* ============================================================================
   ADD A DEPLOYMENT — as a page, at /wofs/:id/deployments/new
   ----------------------------------------------------------------------------
   The builder outgrew its dialog: four steps, a 260-item kit catalogue and a
   role-by-pattern matrix, all scrolling inside a box. Here it has the screen.
   The builder itself lives in DeploymentDialog.tsx (`DeploymentBuilder`) and
   is shared with the dialog, so the two cannot price a deployment differently.

   Leaving with something filled in asks first: Cancel and the breadcrumb go
   through a confirm, and a reload or closed tab gets the browser's own prompt.
   (The app uses a plain BrowserRouter, so the browser Back button cannot be
   intercepted without moving to a data router.)
   ========================================================================== */

import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { EmptyState, PageHeader } from '@/components/primitives';
import { ConfirmDestructive } from '@/components/Modal';
import { fmtRange, money } from '@/lib/format';
import { client as clientById } from '@/data/db';
import { useWofVersion } from '@/lib/useStore';
import * as W from '@/lib/wof';
import { DeploymentBuilder } from './DeploymentDialog';

export default function DeploymentPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  useWofVersion();
  const w = W.byId(id);
  const dirty = useRef(false);
  const [leaving, setLeaving] = useState<string | null>(null);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!dirty.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  if (!w) {
    return (
      <EmptyState
        iconName="fileText"
        title="Work order not found"
        body="That reference does not exist, or the demo data has been reset."
        action={<Link className="btn btn-primary" to="/wofs">Back to the pipeline</Link>}
      />
    );
  }

  const back = `/wofs/${w.id}#quote`;
  const editKey = params.get('edit') || undefined;
  const editing = editKey
    ? W.deployments(w, w.signoff ? 'variation' : 'quote').find((d) => d.key === editKey)
    : undefined;
  const leave = (to: string) => (dirty.current ? setLeaving(to) : navigate(to));
  const isVar = !!w.signoff;
  const client = clientById(w.clientId);
  const soFar = isVar
    ? `Quote ${money(W.quoteValue(w), { pence: false })} + ${money(W.variationValue(w), { pence: false })} in variations`
    : `Quote ${money(W.quoteValue(w), { pence: false })} so far`;

  return (
    <div className="max-w-[1440px]">
      <PageHeader
        crumbs={[
          { label: 'WOF pipeline', to: '/wofs' },
          { label: w.ref, to: back },
          { label: editing ? 'Edit deployment' : 'Add a deployment' },
        ]}
        title={
          editing
            ? `Edit deployment: ${editing.area} · ${editing.placeName}`
            : isVar
              ? 'Add a deployment as a variation'
              : 'Add a deployment'
        }
        subtitle={
          <>
            <span className="font-mono text-[12.5px] text-accent">{w.ref}</span> · {w.title} · {client?.name} ·{' '}
            {fmtRange(w.start, w.end)} · <strong className="text-ink">{soFar}</strong>
          </>
        }
        actions={
          <button type="button" className="btn btn-secondary" onClick={() => leave(back)}>
            Back to the quote
          </button>
        }
      />
      <DeploymentBuilder
        key={editKey || 'new'}
        w={w}
        layout="page"
        editKey={editKey}
        onOpenExisting={(key, auto) => {
          const go = `/wofs/${w.id}/deployments/new?edit=${encodeURIComponent(key)}`;
          if (dirty.current && !auto) setLeaving(go);
          else {
            dirty.current = false;
            navigate(go, { replace: true });
          }
        }}
        // "Add deployment" on a spot that already has one opens it, filled in.
        // `?fresh=1` is the way out: a deliberate second deployment beside it.
        autoOpen={!params.get('fresh')}
        onStartNew={
          editKey
            ? () => {
                const go = `/wofs/${w.id}/deployments/new?fresh=1`;
                if (dirty.current) setLeaving(go);
                else navigate(go, { replace: true });
              }
            : undefined
        }
        replaceLineId={params.get('replace') || undefined}
        onDirty={(d) => {
          dirty.current = d;
        }}
        onClose={() => leave(back)}
        onDone={() => {
          dirty.current = false;
          navigate(back);
        }}
      />
      {leaving ? (
        <ConfirmDestructive
          title="Leave without adding?"
          message="Nothing you picked on this page is on the quote yet. Leave now and it is lost; stay to finish it and press Add."
          confirmLabel="Leave and discard"
          cancelLabel="Keep editing"
          onConfirm={() => {
            dirty.current = false;
            navigate(leaving);
          }}
          onClose={() => setLeaving(null)}
        />
      ) : null}
    </div>
  );
}
