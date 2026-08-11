import { startAppServer } from './server.js';
import { TASKS } from './tasks.js';

const enableControlApi =
  process.argv.includes('--enable-control-api') || process.env['FIXTURE_CONTROL_API'] === '1';
const app = await startAppServer({
  port: Number(process.env['PORT'] ?? 8990),
  enableControlApi,
});

process.stdout.write(
  [
    `Autohaus DMS fixture app   ${app.origin}`,
    `sign in                    test / test`,
    '',
    'screens:',
    '  /app/dashboard            KPI tiles that settle independently',
    '  /app/customers            paging, sorting, search, filter',
    '  /app/customers/:id        lazy contacts + orders panels',
    '  /app/vehicles             12,000 rows, virtualised, ~40 in the DOM',
    '  /app/orders               bulk selection + right-click context menu',
    '  /app/orders/new           4-step wizard: autocomplete, modal picker',
    '  /app/workshop             drag-and-drop scheduler (+ keyboard route)',
    '  /app/parts                three-pane master-detail over a category tree',
    '  /app/tickets              double-click inline editing',
    '  /app/invoices             print view in a second tab, payment ceiling',
    '  /app/reports/query        dynamic condition rows',
    '  /app/reports/export       long-running job with polling',
    '  /app/reports/audit        every mutation the app performed',
    '',
    ...(enableControlApi
      ? [
          'control api (enabled):',
          '  GET  /api/tasks           the task list',
          '  GET  /api/tasks/verify    grade every task against the database',
          '  POST /api/reset           restore seed state',
        ]
      : [
          'control api: disabled',
          '  pass --enable-control-api or set FIXTURE_CONTROL_API=1 to enable it',
        ]),
    '  ?latency=<ms>             override artificial latency on any request',
    '',
    `tasks (${TASKS.length}):`,
    ...TASKS.map((t) => `  ${t.id.padEnd(24)} ${t.skills.join(', ')}`),
    '',
  ].join('\n'),
);

const shutdown = () => void app.close().then(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
