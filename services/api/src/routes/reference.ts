import type { FastifyPluginAsync } from 'fastify';
import {
  DEFAULT_LOCALE,
  REFERENCE_TYPES,
  referenceQuerySchema,
  type ReferenceItem,
  type ReferenceType,
} from '@nikahmate/domain';
import { badRequest, notFound } from '../errors.js';
import type { Db } from '../db/types.js';

/**
 * Reference data — the only genuinely public endpoints in v1.
 *
 * One generic route per shape rather than nineteen bespoke ones (ADR 0009).
 * Runs as `anon`: there is nothing here that varies by caller, and reading it
 * as the caller would mean an authenticated round trip for data that is the
 * same for everybody.
 */

interface ItemRow {
  code: string;
  type: ReferenceType;
  label: string | null;
  description: string | null;
  parent_code: string | null;
  sort_order: number;
}

/**
 * Labels fall back to the default locale rather than returning null.
 *
 * A half-translated catalog should show English, not a blank option in a
 * dropdown someone has to choose from to finish signing up.
 */
const ITEM_SELECT = `
  select i.code,
         i.type,
         coalesce(t.label, fallback.label) as label,
         coalesce(t.description, fallback.description) as description,
         parent.code as parent_code,
         i.sort_order
  from public.reference_items i
  left join public.reference_translations t
    on t.reference_item_id = i.id and t.locale = $1
  left join public.reference_translations fallback
    on fallback.reference_item_id = i.id and fallback.locale = $2
  left join public.reference_items parent on parent.id = i.parent_id
`;

function toItem(row: ItemRow): ReferenceItem {
  return {
    code: row.code,
    type: row.type,
    // Falling back to the code keeps a missing translation visible as a bug
    // rather than rendering an empty row.
    label: row.label ?? row.code,
    description: row.description,
    parentCode: row.parent_code,
    sortOrder: row.sort_order,
  };
}

function parseType(value: unknown): ReferenceType {
  if (typeof value !== 'string' || !(REFERENCE_TYPES as readonly string[]).includes(value)) {
    throw notFound(`Unknown reference type`);
  }
  return value as ReferenceType;
}

export interface ReferenceRoutesOptions {
  db: Db;
}

export const referenceRoutes: FastifyPluginAsync<ReferenceRoutesOptions> = async (
  fastify,
  { db },
) => {
  /**
   * GET /reference/manifest
   *
   * A content hash per type. The client re-fetches a type only when its hash
   * changes — on a 3G connection in a target market that is the difference
   * between a usable app and a spinner.
   */
  fastify.get('/reference/manifest', async () => {
    const rows = await db.asAnon((session) =>
      session.query<{ type: ReferenceType; hash: string }>(`
        select i.type,
               md5(string_agg(i.code || ':' || i.updated_at::text, ',' order by i.code)) as hash
        from public.reference_items i
        where i.active
        group by i.type
      `),
    );
    return Object.fromEntries(rows.map((r) => [r.type, r.hash]));
  });

  /** GET /reference/:type */
  fastify.get('/reference/:type', async (request) => {
    const params = request.params as { type?: string };
    const type = parseType(params.type);

    const query = referenceQuerySchema.safeParse(request.query);
    if (!query.success) {
      throw badRequest('Invalid query');
    }
    const locale = query.data.locale ?? DEFAULT_LOCALE;

    return db.asAnon(async (session) => {
      const rows = await session.query<ItemRow>(
        `${ITEM_SELECT}
         where i.type = $3
           and i.active
           and ($4::text is null or parent.code = $4)
         order by i.sort_order, i.code`,
        [locale, DEFAULT_LOCALE, type, query.data.parentCode ?? null],
      );

      const hashRows = await session.query<{ hash: string | null }>(
        `select md5(string_agg(code || ':' || updated_at::text, ',' order by code)) as hash
         from public.reference_items where type = $1 and active`,
        [type],
      );

      return {
        type,
        hash: hashRows[0]?.hash ?? '',
        items: rows.map(toItem),
      };
    });
  });

  /** GET /reference/:type/:code */
  fastify.get('/reference/:type/:code', async (request) => {
    const params = request.params as { type?: string; code?: string };
    const type = parseType(params.type);
    const code = params.code;
    if (!code) throw notFound('Unknown reference item');

    const query = referenceQuerySchema.safeParse(request.query);
    const locale = (query.success ? query.data.locale : undefined) ?? DEFAULT_LOCALE;

    const rows = await db.asAnon((session) =>
      session.query<ItemRow>(`${ITEM_SELECT} where i.type = $3 and i.code = $4 and i.active`, [
        locale,
        DEFAULT_LOCALE,
        type,
        code,
      ]),
    );

    const row = rows[0];
    if (!row) throw notFound('Unknown reference item');
    return toItem(row);
  });
};
