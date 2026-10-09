export interface ManageAdminPayload {
  email: string;
  action: 'add' | 'remove';
  role?: 'superAdmin' | 'platformAdmin';
}

export interface AdminInfo {
  uid: string;
  email: string;
  displayName: string | undefined;
  photoURL: string | undefined;
  role?: 'superAdmin' | 'platformAdmin';
  status?: 'active' | 'pending';
  pending?: boolean;
  addedAt?: string;
}

export type ProvisioningMode = 'EMPTY' | 'CATALOG_ONLY' | 'FULL_DEMO';

export type BusinessVertical =
  | 'INDUMENTARIA_MODA'
  | 'GASTRONOMIA_CAFE'
  | 'TECNOLOGIA'
  | 'HOGAR_DECO';

export interface PricingOverride {
  type: 'custom_fixed_price' | 'percentage_discount' | 'fixed_discount';
  value: number;
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
  currentPeriodEnd?: FirebaseFirestore.Timestamp | Date | string;
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

export interface CreateStorePayload {
  name: string;
  slug: string;
  ownerEmail: string;
  subdomain?: string;
  desiredSubdomain?: string;
  logoUrl?: string;
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

export type StoreRuntimeMode = 'shared-shard' | 'dedicated-project';

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
  /** Billing account GCP que paga este shard (atribución real, ver complete-shards.ts). */
  billingAccountId?: string;
  /** Estado del redirect URI en el client OAuth master (cache persistida). */
  redirectUriStatus?: 'registered' | 'missing';
  ready?: boolean;
  redirectUriCheckedAt?: Date;
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

export type StepStatus = 'pending' | 'running' | 'done' | 'error';

export interface ProvisioningStep {
  status: StepStatus;
  label: string;
  detail?: string | null;
  error?: string;
}

export interface AddBillingAccountPayload {
  id: string;
  name: string;
  maxProjects?: number;
  gcpProjectLimit?: number;
}

export interface UpdateBillingAccountPayload {
  id: string;
  name?: string;
  maxProjects?: number;
  active?: boolean;
  gcpProjectLimit?: number;
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
  webhookUrl: string;
  sandbox?: boolean;
  validationStatus?: 'pending' | 'valid' | 'invalid';
  validationMessage?: string;
  validatedAt?: string;
}

export interface StorePayments {
  mercadoPago: StoreMercadoPagoConfig;
}

export interface StoreTheme {
  primaryColor: string;
  secondaryColor: string;
  backgroundColor: string;
  textColor: string;
  borderRadius: 'none' | 'sm' | 'md' | 'lg' | 'full';
  fontFamily: 'Inter' | 'Roboto' | 'Outfit' | 'Playfair Display';
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
  theme?: StoreTheme;
  currency: string;
  currencySymbol: string;
  country: string;
}

export interface UpdateStoreConfigPayload {
  storeId: string;
  config: Partial<StoreConfig>;
}

export interface InviteStaffPayload {
  storeId: string;
  email: string;
  role: 'admin' | 'staff' | 'warehouse' | 'fulfillment' | 'analyst';
}

export interface RedeployStorePayload {
  storeId: string;
  ref?: string;
}
