// Fredy API client — authenticate and poll listings.
//
// Fredy's REST API (Fastify on port 9998):
//   POST /api/login               { username, password }  → session cookie
//   GET  /api/listings/table       ?providerFilter=immoscout&page=1&pageSize=20
//   GET  /api/jobs                 list configured jobs

const DEFAULT_PAGE_SIZE = 20;

export class FredyClient {
  /**
   * @param {string} baseUrl  e.g. "http://fredy:9998"
   * @param {string} username
   * @param {string} password
   */
  constructor(baseUrl, username, password) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.username = username;
    this.password = password;
    this.cookie = null; // session cookie after login
  }

  /** Authenticate and store session cookie. Throws on failure. */
  async login() {
    const resp = await fetch(`${this.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password }),
    });
    if (!resp.ok) {
      throw new Error(`AUTH_FAILED: HTTP ${resp.status}`);
    }
    // Fredy sets a session cookie; node-fetch / built-in fetch stores it per-request,
    // so we extract and reuse the Set-Cookie header.
    const setCookie = resp.headers.get('set-cookie');
    if (setCookie) {
      this.cookie = setCookie.split(';')[0]; // just the key=value part
    }
  }

  /**
   * Fetch all IS24 listings for a given job_id, paginating if needed.
   * @param {string} jobId
   * @returns {Promise<Array<{id: string, title: string, price: number, link: string, address: string, job_id: string}>>}
   */
  async getListings(jobId) {
    const allListings = [];
    let page = 1;

    while (true) {
      const url = new URL(`${this.baseUrl}/api/listings/table`);
      url.searchParams.set('providerFilter', 'immoscout');
      url.searchParams.set('page', String(page));
      url.searchParams.set('pageSize', String(DEFAULT_PAGE_SIZE));

      const headers = { 'Content-Type': 'application/json' };
      if (this.cookie) headers['Cookie'] = this.cookie;

      const resp = await fetch(url.toString(), { headers });
      if (!resp.ok) {
        throw new Error(`Fredy API returned HTTP ${resp.status}`);
      }

      const data = await resp.json();
      const results = data.result || [];
      allListings.push(...results);

      if (results.length < DEFAULT_PAGE_SIZE) break;
      page++;
    }

    // Filter to only the specified job_id
    return allListings.filter((l) => l.job_id === jobId);
  }
}
