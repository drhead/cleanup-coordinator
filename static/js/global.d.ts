import type { Alpine as AlpineType, interceptor } from 'alpinejs';

declare global {
  interface Window {
    Alpine?: AlpineType;
    ComparisonManager?: any;
    ReconciliationManager?: any;
  }

  var Alpine: AlpineType;

  // Domain Models
  interface Lease {
    batch_id: number | string;
    batch_number: number;
    project_id: number | string;
    leased_until: string;
    is_leased_by_you?: boolean;
  }

  interface Project {
    project_id: number | string;
    name: string;
    resolved_clusters?: number;
    total_clusters?: number;
  }

  type TagCategory = 
    | 'ARTIST' 
    | 'CONTRIBUTOR' 
    | 'COPYRIGHT' 
    | 'CHARACTER' 
    | 'SPECIES' 
    | 'GENERAL' 
    | 'META' 
    | 'LORE' 
    | 'INVALID';

  interface ClusterPost {
    post_id: number;
    cluster_id: number;
    rating: string;
    pool_ids: number[];
    is_flagged: boolean;
    is_deleted: boolean;
    tags: string[];
    image_width: number;
    image_height: number;
    image_format: string;
    image_quality: number;
    fileUrl?: string;
    _tagsSignature?: string;
    _sortedTags?: Array<{ name: string; category: TagCategory }>;
  }

  interface ClusterPair {
    a: ClusterPost;
    b: ClusterPost;
    relationship?: string | null;
  }

  interface Cluster {
    cluster_id: number;
    cluster_index: int;
    note: string | null;
    is_resolved: boolean;
    manual_resolution: boolean;
    posts: ClusterPost[];
    collapsed?: boolean;
    is_blacklisted?: boolean;
    matched_rule?: string | null;
    canonical_rating?: string;
    isRefreshing?: boolean;
    pairs?: ClusterPair[];
    default_type?: string;
    _fetchedPosts?: Map<number, string>;
  }

  interface Batch {
    batch_id: number;
    project_id: string;
    batch_number: number;
    status: string;
    leased_until: string | null;
    is_leased_by_you: boolean;
    resolved_count: number;
    total_clusters: number;
    clusters: Cluster[];
    isRefreshing?: boolean;
  }

  interface E621User {
    username: string;
    apiKey: string;
    id: number;
  }

  // Feature-Specific State Slices (Decoupled from redundant toast arrays)
  interface BatchState {
    activeProject: Project | null;
    projects?: Project[];
    batches: Batch[];
    activeBatch: Batch | null;
    activeLease: Lease | null;
    currentScreen?: string;
    nowTimestamp?: number;
    blacklistText?: string;
    pollInterval?: any;
  }

  interface BlacklistState {
    blacklistText: string;
    isImportingBlacklist: boolean;
    showBlacklistModal: boolean;
    batches?: Batch[];
    e621User?: E621User | null;
  }

  interface AuthState {
    showLoginModal: boolean;
    isLoggingIn: boolean;
    loginError: string | null;
    loginForm: { username: string; apiKey: string };
    e621User: E621User | null;
  }

  interface TagState {
    implications: Record<string, { implies?: string[]; implied_by?: string[] }>;
    hasImplications: boolean;
    tagData: Record<string, number[]>;
    hasTagData: boolean;
  }

  // Toast System Definitions
  interface Toast {
    id: number | string;
    message: string;
    type?: 'success' | 'error' | 'warning' | 'info';
    duration?: number;
  }

  interface ToastState {
    toasts: Toast[];
  }

  // Master Root Application State (Combines all slices + central toasts + user session)
  interface AppState extends BatchState, ToastState, BlacklistState, AuthState, TagState {}
}

export {};