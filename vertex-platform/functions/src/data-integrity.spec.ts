import { describe, it, expect, vi } from 'vitest';
import {
  auditShardSnapshot,
  collectAssetUrls,
  findDanglingCategoryRefs,
  findInvalidShardEnvironments,
  findMissingSingletons,
  findMissingStoreId,
  findMissingStoreOwnerRoles,
  findMissingAdminClaims,
  findOrphanDocs,
  findUnreachableAssets,
  integrityAlertKey,
  staleAlertKeys,
  tenantOfDoc,
  VALID_ENVIRONMENTS,
  type ShardSnapshot,
} from './data-integrity';

const snapshot = (collections: ShardSnapshot['collections'], tenants: string[]): ShardSnapshot => ({
  projectId: 'vtx-sd-test',
  tenants: new Set(tenants),
  collections,
});

describe('tenantOfDoc', () => {
  it('usa storeId cuando está presente', () => {
    expect(tenantOfDoc('cualquier-id', 'maravilla', 'hint')).toBe('maravilla');
  });

  it('resuelve singletons por prefijo', () => {
    expect(tenantOfDoc('home_maravilla', null, 'hint')).toBe('maravilla');
    expect(tenantOfDoc('store_diente-de-leon', null, 'hint')).toBe('diente-de-leon');
    expect(tenantOfDoc('emailTemplates_kasakalle', null, 'hint')).toBe('kasakalle');
  });

  it('resuelve IDs compuestos del catálogo y de admin_roles', () => {
    expect(tenantOfDoc('maravilla-prod-7', null, 'hint')).toBe('maravilla');
    expect(tenantOfDoc('martes-ORD-1001', null, 'hint')).toBe('martes');
    expect(tenantOfDoc('gran-tienda_dueno@mail.com', null, 'hint')).toBe('gran-tienda');
  });

  it('cae al hint del shard cuando no puede clasificar', () => {
    expect(tenantOfDoc('wMBPW63G', null, 'cuatro-estaciones')).toBe('cuatro-estaciones');
  });
});

describe('findOrphanDocs', () => {
  it('detecta documentos de tenants que ya no existen', () => {
    const findings = findOrphanDocs(
      snapshot(
        {
          products: [
            { id: 'gran-tienda-prod-1', storeId: 'gran-tienda' },
            { id: 'diente-de-leon-prod-1', storeId: 'diente-de-leon' },
          ],
          categories: [{ id: 'home_locura', storeId: null }],
        },
        ['diente-de-leon'],
      ),
      'diente-de-leon',
    );
    expect(findings).toHaveLength(2);
    const tenants = findings.map((f) => f.tenant).sort();
    expect(tenants).toEqual(['gran-tienda', 'locura']);
    expect(findings.every((f) => f.kind === 'orphan_docs' && f.severity === 'critical')).toBe(true);
  });

  it('no reporta nada cuando todos los documentos pertenecen a tenants vivos', () => {
    const findings = findOrphanDocs(
      snapshot({ products: [{ id: 'kasakalle-prod-1', storeId: 'kasakalle' }] }, ['kasakalle']),
      'kasakalle',
    );
    expect(findings).toEqual([]);
  });

  it('ignora documentos inclasificables (sin tenant y sin hint)', () => {
    const findings = findOrphanDocs(snapshot({ products: [{ id: 'random-id' }] }, []), '');
    expect(findings).toEqual([]);
  });
});

describe('findMissingStoreId', () => {
  it('detecta documentos sin storeId en colecciones consultadas por storeId', () => {
    const findings = findMissingStoreId(
      snapshot({ orders: [{ id: '3GTT4B45' }, { id: 'A9HV9GC8' }] }, ['ec7ipse']),
      'ec7ipse',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('missing_store_id');
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].tenant).toBe('ec7ipse');
    expect(findings[0].key).toContain('orders');
  });

  it('no reporta colecciones que no se consultan por storeId', () => {
    const findings = findMissingStoreId(
      snapshot({ settings: [{ id: 'emailEngine_x' }] }, ['x']),
      'x',
    );
    expect(findings).toEqual([]);
  });

  it('ignora documentos sin storeId de tenants inexistentes (se reportan como huérfanos)', () => {
    const findings = findMissingStoreId(snapshot({ products: [{ id: 'foo' }] }, []), '');
    expect(findings).toEqual([]);
  });
});

describe('findDanglingCategoryRefs', () => {
  it('detecta productos que apuntan a categorías inexistentes', () => {
    const findings = findDanglingCategoryRefs(
      snapshot(
        {
          categories: [{ id: 'tienda-cat-living', storeId: 'tienda' }],
          products: [
            { id: 'tienda-prod-1', storeId: 'tienda', data: { categoryId: 'tienda-cat-living' } },
            { id: 'tienda-prod-2', storeId: 'tienda', data: { categoryId: 'tienda-cat-fantasma' } },
          ],
        },
        ['tienda'],
      ),
      'tienda',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('dangling_ref');
    expect(findings[0].message).toContain('tienda-cat-fantasma');
  });

  it('ignora productos sin categoryId', () => {
    const findings = findDanglingCategoryRefs(
      snapshot({ products: [{ id: 'p1', storeId: 't', data: {} }] }, ['t']),
      't',
    );
    expect(findings).toEqual([]);
  });
});

describe('findMissingSingletons', () => {
  it('reporta cuando falta la configuración núcleo de un tenant', () => {
    const findings = findMissingSingletons(
      snapshot({ configuracion: [{ id: 'store_tienda', storeId: 'tienda' }] }, ['tienda']),
      'tienda',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('missing_singleton');
    expect(findings[0].message).toContain('home');
    expect(findings[0].message).toContain('footer');
  });

  it('no reporta nada si los singletons núcleo están presentes', () => {
    const findings = findMissingSingletons(
      snapshot(
        {
          configuracion: [{ id: 'store_tienda' }, { id: 'footer_tienda' }],
          banners: [{ id: 'home_tienda' }],
        },
        ['tienda'],
      ),
      'tienda',
    );
    expect(findings).toEqual([]);
  });
});

describe('findInvalidShardEnvironments', () => {
  it('detecta environments fuera del enum', () => {
    const findings = findInvalidShardEnvironments([
      { id: 'shard-production-a', environment: 'production' },
      { id: 'shard-production-b', environment: 'prod' },
      { id: 'shard-production-c', environment: null },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('invalid_enum');
    expect(findings[0].message).toContain('shard-production-b');
    expect(findings[0].message).toContain(VALID_ENVIRONMENTS.join(' | '));
  });

  it('no reporta cuando todos los environments son válidos', () => {
    expect(
      findInvalidShardEnvironments(
        VALID_ENVIRONMENTS.map((e, i) => ({ id: `s${i}`, environment: e })),
      ),
    ).toEqual([]);
  });
});

describe('findUnreachableAssets', () => {
  it('reporta las URLs que no responden', async () => {
    const fetchImpl = vi.fn(async (url: string) => ({ ok: url.includes('ok'), status: 404 }));
    const findings = await findUnreachableAssets(['https://x/ok.jpg', 'https://x/rota.jpg'], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('unreachable_asset');
    expect(findings[0].message).toContain('rota.jpg');
  });

  it('no reporta nada cuando todas responden y deduplica URLs repetidas', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const findings = await findUnreachableAssets(['https://x/a.jpg', 'https://x/a.jpg'], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(findings).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('marca como rota una URL que arroja excepción y respeta el límite', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network');
    });
    const findings = await findUnreachableAssets(['https://x/a.jpg', 'https://x/b.jpg'], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      limit: 1,
    });
    expect(findings[0].message).toContain('inaccesible');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('auditShardSnapshot', () => {
  it('combina todos los detectores', () => {
    const findings = auditShardSnapshot(
      snapshot(
        {
          products: [{ id: 'fantasma-prod-1', storeId: 'fantasma' }],
          orders: [{ id: 'tienda-ORD-1' }],
          configuracion: [{ id: 'store_tienda' }],
        },
        ['tienda'],
      ),
      'tienda',
    );
    const kinds = findings.map((f) => f.kind).sort();
    expect(kinds).toEqual(['missing_singleton', 'missing_store_id', 'orphan_docs']);
  });
});

describe('collectAssetUrls', () => {
  it('extrae URLs de imagen anidadas y descarta las que no lo son', () => {
    const urls = collectAssetUrls(
      snapshot(
        {
          products: [
            {
              id: 'p1',
              storeId: 't',
              data: {
                image: 'https://x/a.jpg',
                images: ['https://x/b.webp?w=800', 'https://sitio/pagina'],
                nested: { logoUrl: 'https://x/c.png' },
              },
            },
          ],
        },
        ['t'],
      ),
    );
    expect(urls.sort()).toEqual(['https://x/a.jpg', 'https://x/b.webp?w=800', 'https://x/c.png']);
  });

  it('no explota con datos vacíos', () => {
    expect(collectAssetUrls(snapshot({}, []))).toEqual([]);
  });
});

describe('staleAlertKeys e integrityAlertKey', () => {
  it('resuelve sólo las claves que ya no aplican', () => {
    expect(
      staleAlertKeys(['data-integrity:a', 'data-integrity:b', 'other:kind'], ['data-integrity:a']),
    ).toEqual(['data-integrity:b', 'other:kind']);
  });

  it('normaliza la clave de alerta con el prefijo del auditor', () => {
    expect(
      integrityAlertKey({
        key: 'x',
        severity: 'warning',
        kind: 'orphan_docs',
        tenant: 't',
        projectId: 'p',
        title: 't',
        message: 'm',
      }),
    ).toBe('data-integrity:x');
    expect(
      integrityAlertKey({
        key: 'data-integrity:y',
        severity: 'warning',
        kind: 'orphan_docs',
        tenant: 't',
        projectId: 'p',
        title: 't',
        message: 'm',
      }),
    ).toBe('data-integrity:y');
  });
});

describe('findMissingStoreOwnerRoles', () => {
  it('detecta dueños de tiendas activas sin admin_roles en el shard', () => {
    const findings = findMissingStoreOwnerRoles(
      [
        { slug: 'kasakalle', ownerEmail: 'ayefemma@gmail.com' },
        { slug: 'otra-tienda', ownerEmail: 'dueno@test.com' },
      ],
      snapshot(
        {
          admin_roles: [
            { id: 'kasakalle_ayefemma@gmail.com', data: { email: 'ayefemma@gmail.com' } },
          ],
        },
        ['kasakalle', 'otra-tienda'],
      ),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('missing_admin_role');
    expect(findings[0].tenant).toBe('otra-tienda');
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].key).toContain('otra-tienda:dueno@test.com');
  });

  it('no reporta hallazgos si todos los dueños tienen su documento', () => {
    const findings = findMissingStoreOwnerRoles(
      [{ slug: 'kasakalle', ownerEmail: 'ayefemma@gmail.com' }],
      snapshot(
        {
          admin_roles: [
            { id: 'kasakalle_ayefemma@gmail.com', data: { email: 'ayefemma@gmail.com' } },
          ],
        },
        ['kasakalle'],
      ),
    );

    expect(findings).toEqual([]);
  });
});

describe('findMissingAdminClaims', () => {
  it('detecta usuarios en admin_roles sin custom claim admin=true o sin rol', () => {
    const findings = findMissingAdminClaims(
      'vtx-sd-test',
      [
        { uid: 'u1', email: 'admin@test.com', claims: undefined },
        { uid: 'u2', email: 'owner@test.com', claims: { admin: true, role: 'owner' } },
        { uid: 'u3', email: 'staff@test.com', claims: { role: 'admin' } }, // missing admin: true
      ],
      new Set(['admin@test.com', 'owner@test.com', 'staff@test.com']),
    );

    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.title)).toContain(
      'Claims administrativos ausentes en Firebase Auth (admin@test.com)',
    );
    expect(findings.map((f) => f.title)).toContain(
      'Claims administrativos ausentes en Firebase Auth (staff@test.com)',
    );
    expect(findings[0].severity).toBe('critical');
  });

  it('ignora usuarios que no figuran en admin_roles', () => {
    const findings = findMissingAdminClaims(
      'vtx-sd-test',
      [{ uid: 'u1', email: 'cliente@test.com', claims: undefined }],
      new Set(['admin@test.com']),
    );

    expect(findings).toEqual([]);
  });
});
