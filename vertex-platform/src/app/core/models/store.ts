export type StoreStatus = 'provisioning' | 'active' | 'suspended' | 'error';
export type StepStatus = 'pending' | 'running' | 'done' | 'error';
export type VersionUpdateStatus = 'idle' | 'updating' | 'failed';
export type StoreRuntimeMode = 'shared-shard' | 'dedicated-project';

export interface TemplateVersion {
  version: string;
  tag: string;
  publishedAt: string;
  isLatest: boolean;
  notes?: string;
  /** Esquema de datos que la versión requiere/produce (gate de compatibilidad). */
  schemaVersion?: number;
}

export type DeploySourceKind = 'release' | 'branch' | 'commit';

/**
 * Fuente de la que se compiló (o se está compilando) el storefront de la tienda.
 * `release` = tag publicado (canal estable); `branch`/`commit` = despliegue de prueba sin tag.
 */
export interface StoreDeploySource {
  kind: DeploySourceKind;
  /** `v0.9.5` | `develop` | `feat/x` | `a1b2c3d` */
  ref: string;
  /** Ref git enviado a GitHub Actions. */
  gitRef?: string;
  commitSha?: string;
  commitMessage?: string;
  commitDate?: string;
  status?: 'pending' | 'ok' | 'failed';
  error?: string | null;
  requestedAt?: Date | string;
  requestedBy?: string;
}

/** Rama del repositorio storefront, tal como la devuelve `listTemplateRefs`. */
export interface TemplateBranch {
  name: string;
  sha: string;
  shortSha: string;
  isDefault: boolean;
}

/** Petición explícita de fuente de despliegue (payload de `redeployStore`). */
export interface DeploySourceRequest {
  kind: DeploySourceKind;
  value: string;
}

export interface TemplateRefs {
  defaultBranch: string;
  branches: TemplateBranch[];
  releases: TemplateVersion[];
}

export interface ProvisioningStep {
  status: StepStatus;
  label: string;
  detail?: string | null;
  error?: string;
}

export interface Store {
  id: string;
  name: string;
  slug: string;
  tenantId?: string;
  runtimeMode?: StoreRuntimeMode;
  shardId?: string | null;
  runtimeProjectId?: string;
  runtimeSiteId?: string;
  firebaseProjectId: string;
  defaultUrl: string;
  customDomain?: string;
  status: StoreStatus;
  logoUrl?: string | null;
  ownerEmail: string;
  createdAt: Date;
  updatedAt: Date;
  lastDeployedAt?: Date;
  templateVersion?: string;
  appVersion?: string;
  targetChannel?: string;
  schemaVersion?: number;
  templateCommit?: string;
  /** Fuente de la que se compiló el storefront (release o prueba). */
  deploySource?: StoreDeploySource;
  /** SHA corto del último build desplegado, reportado por el workflow. */
  lastDeployedCommit?: string;
  /** Opt-in explícito para permitir ramas/commits en tiendas que no son development. */
  allowTestDeployments?: boolean;
  versionUpdateStatus?: VersionUpdateStatus;
  versionUpdateTarget?: string;
  versionUpdateProgress?: {
    step?: string;
    pct?: number;
    updatedAt?: string;
  };
  redeployStatus?: 'idle' | 'deploying' | 'failed';
  redeployError?: string | null;
  redeployStartedAt?: Date | string | null;
  pendingMigration?: boolean;
  autoUpdate?: boolean;
  environment?: 'development' | 'production';
  billingAccountId?: string;
  /** Tienda corporativa/interna: exenta del circuito de suscripción SaaS de terceros. */
  isExempt?: boolean;
  plan?: 'internal' | 'standard';
  /**
   * Cantidad de sitios/dominios EXTRA contratados (add-on pago).
   * Cada sitio `.web.app` consume 1 de los 36 disponibles por shard, por eso es pago.
   */
  extraDomainsEntitlement?: number;
  provisioningSteps?: Record<string, ProvisioningStep>;
  unhandledProvisioningError?: string | null;
  error?: string | null;
  verticalId?: string;
  businessVertical?: BusinessVertical;
  provisioningMode?: ProvisioningMode;
  subdomain?: string;
  subscription?: StoreSubscription;
}

export interface PricingOverride {
  type: 'custom_fixed_price' | 'percentage_discount' | 'fixed_discount';
  value: number; // Ej: 18000 para precio fijo, 30 para 30%, 5000 para $5000 OFF
  duration: 'lifetime' | 'recurring_cycles' | 'single_cycle';
  cyclesRemaining?: number;
  cyclesApplied?: number;
  reason: string;
  assignedBy: string;
  assignedAt: string;
}

export interface StoreSubscription {
  status?:
    | 'active'
    | 'complimentary'
    | 'trial'
    | 'past_due'
    | 'suspended'
    | 'legacy_prepaid'
    | 'trialing'
    | 'grace_period';
  currentPeriodEnd?: string;
  trialDaysRemaining?: number;
  trialDays?: number | null;
  billingCycle?: 'monthly' | 'annual';
  paymentMethod?: 'mercadopago' | 'manual_bridge' | 'transfer' | string;
  prepaidNotes?: string;
  customMonthlyPrice?: number | null;
  customAnnualPrice?: number | null;
  discountPercent?: number | null;
  pricingOverride?: PricingOverride | null;
  lastGeneratedLink?: string;
  preapprovalId?: string;
  preferenceId?: string;
  amount?: number;
  updatedAt?: Date | string;
  updatedBy?: string;
}

export type ProvisioningMode = 'EMPTY' | 'CATALOG_ONLY' | 'FULL_DEMO';

export type BusinessVertical =
  'INDUMENTARIA_MODA' | 'GASTRONOMIA_CAFE' | 'TECNOLOGIA' | 'HOGAR_DECO';

export interface CreateStorePayload {
  name: string;
  slug: string;
  ownerEmail: string;
  subdomain?: string;
  desiredSubdomain?: string;
  logoUrl?: string | null;
  customDomain?: string;
  verticalId?: string;
  businessVertical?: BusinessVertical;
  provisioningMode?: ProvisioningMode;
  includeMockData?: boolean;
  dedicatedProject?: boolean;
  initialSubscriptionStatus?: 'trial' | 'complimentary' | 'active';
  trialDays?: number;
  customMonthlyPrice?: number;
  customAnnualPrice?: number;
}

export interface StoreShard {
  id: string;
  environment: 'development' | 'production';
  runtimeMode: 'shared-shard';
  projectId: string;
  siteId: string;
  region: string;
  status:
    | 'ACTIVE'
    | 'FULL'
    | 'DRAINING'
    | 'MAINTENANCE'
    | 'WARMUP_READY'
    | 'WARMUP_PROVISIONING'
    | 'PARTIALLY_CONFIGURED'
    | 'DECOMMISSIONED';
  maxCapacity: number;
  currentStores: number;
  reservedStores: number;
  currentTemplateVersion?: string;
  currentDataVersion?: string;
  healthStatus?: 'HEALTHY' | 'UNREACHABLE' | 'DEGRADED';
  errorReason?: string;
  readinessChecklist?: ShardReadinessChecklist;
  missingSteps?: string[];
  actionableFixes?: string[];
  lastValidatedAt?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ShardReadinessChecklist {
  gcpProjectAccessible: boolean;
  canonicalApisReady: boolean;
  iamRolesBound: boolean;
  oauthRedirectConfigured: boolean;
  authDomainsWhitelisted: boolean;
  firestoreReady: boolean;
}

export interface StoreContact {
  email: string;
  phone: string;
  whatsapp: string;
  address?: string;
  instagram?: string;
  facebook?: string;
}

export interface StoreSeo {
  metaTitle: string;
  metaDescription: string;
}

export interface StoreFeatureFlags {
  reviewsEnabled: boolean;
  wishlistEnabled: boolean;
  blogEnabled: boolean;
}

export interface StoreMercadoPagoConfig {
  publicKey: string;
  accessToken?: string;
  accessTokenSecret?: string;
  accessTokenMasked?: string;
  accountEmail?: string;
  accountUserId?: string;
  webhookUrl?: string;
  sandbox?: boolean;
  validationStatus?: 'pending' | 'valid' | 'invalid';
  validationMessage?: string;
  validatedAt?: string;
}

export interface StorePayments {
  mercadoPago: StoreMercadoPagoConfig;
}

export interface StoreConfig {
  storeName: string;
  strapline: string;
  logoUrl: string;
  faviconUrl?: string;
  contact: StoreContact;
  seo: StoreSeo;
  features: StoreFeatureFlags;
  payments?: StorePayments;
  currency: string;
  currencySymbol: string;
  country: string;
}

export interface StaffMember {
  uid: string;
  email: string;
  role: 'owner' | 'admin' | 'staff' | 'warehouse' | 'fulfillment' | 'analyst';
  displayName?: string;
  joinedAt?: string;
  isOwner?: boolean;
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  status: 'pending' | 'accepted' | 'expired';
  createdAt: string;
}
