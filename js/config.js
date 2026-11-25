import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const config = window.WHISPER_CONFIG || {};
export const configured = Boolean(config.supabaseUrl && config.supabaseAnonKey);
export const supabase = configured ? createClient(config.supabaseUrl, config.supabaseAnonKey) : null;
