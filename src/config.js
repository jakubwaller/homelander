// Load autoapply configuration from YAML file and environment overrides.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = process.env.AUTOAPPLY_CONFIG_DIR || join(__dirname, '..', 'config');
const RUNTIME_DIR = join(__dirname, '..', 'runtime');

/** @returns {object} */
export function loadConfig() {
  // 1. Load YAML config
  const configPath = join(CONFIG_DIR, 'autoapply.config.yaml');
  let cfg = {};
  try {
    const raw = readFileSync(configPath, 'utf8');
    cfg = yaml.load(raw) || {};
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`ERROR: ${configPath} not found. Copy config/autoapply.config.example.yaml and fill in your values.`);
      process.exit(1);
    }
    throw err;
  }

  // 2. Message template from runtime/
  const messagePath = join(RUNTIME_DIR, 'message.txt');
  try {
    cfg.message = readFileSync(messagePath, 'utf8').trim();
  } catch {
    console.error(`ERROR: ${messagePath} not found. Create it with your message template.`);
    process.exit(1);
  }

  // 3. IS24 cookies (optional — for pre-authenticated sessions)
  const cookiesPath = join(RUNTIME_DIR, 'cookies.json');
  try {
    cfg.cookies = JSON.parse(readFileSync(cookiesPath, 'utf8'));
  } catch {
    cfg.cookies = null;
    console.warn('WARN: No cookies.json found — will rely on host Chrome profile for auth.');
  }

  // 4. Environment overrides
  cfg.dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  cfg.speed = process.env.SPEED || cfg.speed || 'balanced';  // 'fast', 'balanced', or 'slow'
  cfg.timing = cfg.timing || {};  // per-timer overrides from config
  cfg.maxSendsPerRun = (() => {
    const raw = process.env.MAX_SENDS_PER_RUN ?? cfg.polling?.max_sends_per_run;
    return raw != null ? parseInt(raw, 10) : 0;  // 0 = no limit
  })();
  cfg.cdpUrl = process.env.CDP_URL || cfg.chrome?.cdp_url || 'http://host.docker.internal:9222';
  cfg.fredyBaseUrl = process.env.FREDY_URL || cfg.fredy?.base_url || 'http://fredy:9998';
  cfg.fredyUsername = process.env.FREDY_USERNAME || cfg.fredy?.username || 'admin';
  cfg.fredyPassword = process.env.FREDY_PASSWORD || cfg.fredy?.password || 'admin';
  cfg.jobId = process.env.FREDY_JOB_ID || cfg.fredy?.job_id || '';
  cfg.captchaApiKey = process.env.CAPTCHA_API_KEY || cfg.captcha?.api_key || '';

  return cfg;
}
