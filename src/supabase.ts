import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Check environment variables first, then localStorage fallback
const envUrl = import.meta.env.VITE_SUPABASE_URL;
const envKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

const storedUrl = typeof window !== "undefined" ? localStorage.getItem("woomap_supabase_url") : null;
const storedKey = typeof window !== "undefined" ? localStorage.getItem("woomap_supabase_key") : null;

export const supabaseUrl = envUrl || storedUrl || "";
export const supabaseKey = envKey || storedKey || "";

export const supabaseConfigured = Boolean(supabaseUrl && supabaseKey);

export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(supabaseUrl, supabaseKey)
  : null;

export function configureSupabaseCredentials(url: string, key: string) {
  if (typeof window !== "undefined") {
    if (url && key) {
      localStorage.setItem("woomap_supabase_url", url.trim());
      localStorage.setItem("woomap_supabase_key", key.trim());
    } else {
      localStorage.removeItem("woomap_supabase_url");
      localStorage.removeItem("woomap_supabase_key");
    }
    window.location.reload();
  }
}
