import { esc, layout } from './views.js';
import type { PageCtx } from './pages.js';

/**
 * A long-running export, run asynchronously and polled for progress.
 *
 * Most benchmark pages resolve instantly, which quietly excludes an entire
 * class of real agent work: start something, poll until it finishes, then act
 * on the result. Here the job takes several seconds, reports partial progress,
 * and the download link does not exist until it completes — so an agent that
 * does not wait has nothing to click.
 */
export interface Job {
  id: string;
  kind: string;
  startedAt: number;
  durationMs: number;
  rows: number;
  /** Set once complete. */
  csv?: string;
}

const jobs = new Map<string, Job>();

export function startJob(kind: string, rows: number, durationMs = 6000): Job {
  const job: Job = {
    id: Math.random().toString(36).slice(2, 10),
    kind,
    startedAt: Date.now(),
    durationMs,
    rows,
  };
  jobs.set(job.id, job);
  return job;
}

export function jobState(id: string): { status: 'unknown' } | { status: 'running' | 'done'; percent: number; job: Job } {
  const job = jobs.get(id);
  if (!job) return { status: 'unknown' };
  const elapsed = Date.now() - job.startedAt;
  const percent = Math.min(100, Math.floor((elapsed / job.durationMs) * 100));
  if (percent >= 100) return { status: 'done', percent: 100, job };
  return { status: 'running', percent, job };
}

export function clearJobs(): void {
  jobs.clear();
}

export function exportPage(ctx: PageCtx, jobId?: string): string {
  const body = `
<div class="card">
  <h2>Export customers</h2>
  <p class="muted">Generates a CSV of every customer. Large exports take a few seconds.</p>
  <form method="post" action="/app/reports/export">
    <button class="btn primary" type="submit" id="startexport">Start export</button>
  </form>
</div>

${
  jobId
    ? `<div class="card" id="jobcard" data-job="${esc(jobId)}" data-state="running">
  <h2>Export in progress <span class="spinner" aria-label="Working"></span></h2>
  <div class="progress"><i id="bar"></i></div>
  <p class="muted" id="jobstatus" role="status" aria-live="polite">Starting…</p>
  <div id="jobresult"></div>
</div>`
    : ''
}`;

  const script = jobId
    ? `
(function () {
  var card = document.getElementById('jobcard');
  var bar = document.getElementById('bar');
  var status = document.getElementById('jobstatus');
  var result = document.getElementById('jobresult');
  var id = card.getAttribute('data-job');

  function poll() {
    fetch('/api/jobs/' + id)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.status === 'unknown') { status.textContent = 'Job not found.'; return; }
        bar.style.width = d.percent + '%';
        status.textContent = d.status === 'done'
          ? 'Export complete — ' + d.rows + ' rows.'
          : 'Exporting… ' + d.percent + '%';
        if (d.status === 'done') {
          card.setAttribute('data-state', 'done');
          var sp = card.querySelector('.spinner');
          if (sp) sp.remove();
          // The download only exists once the job finishes.
          result.innerHTML = '<a class="btn primary" id="download" href="/app/reports/export/' + id +
            '/download">Download CSV</a>';
          return;
        }
        setTimeout(poll, 500);
      });
  }
  poll();
})();`
    : undefined;

  return layout(body, {
    title: 'Export',
    path: ctx.path,
    user: ctx.user,
    flash: ctx.flash,
    breadcrumbs: [{ label: 'Reports', href: '/app/reports/revenue' }, { label: 'Export' }],
    ...(script ? { script } : {}),
  });
}
