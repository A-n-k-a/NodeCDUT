import { h2Fetch, type H2Response } from "./h2.js";

export type { H2Response as FetchResponse };

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

export class CookieJar {
  private cookies = new Map<string, Cookie>();

  private key(name: string, domain: string, path: string): string {
    return `${domain}|${path}|${name}`;
  }

  private normalizeDomain(domain: string): string {
    return domain.startsWith(".") ? domain.slice(1) : domain;
  }

  private domainMatches(cookieDomain: string, hostname: string): boolean {
    const cd = this.normalizeDomain(cookieDomain).toLowerCase();
    const h = hostname.toLowerCase();
    return h === cd || h.endsWith("." + cd);
  }

  private pathMatches(cookiePath: string, requestPath: string): boolean {
    if (cookiePath === "/" || !cookiePath) return true;
    if (requestPath === cookiePath) return true;
    if (requestPath.startsWith(cookiePath)) {
      if (cookiePath.endsWith("/")) return true;
      return requestPath[cookiePath.length] === "/";
    }
    return false;
  }

  addFromSetCookie(setCookie: string | null | undefined, url: string): void {
    if (!setCookie) return;
    const firstPart = setCookie.split(";")[0];
    const eqIdx = firstPart.indexOf("=");
    if (eqIdx < 0) return;
    const name = firstPart.slice(0, eqIdx).trim();
    const value = firstPart.slice(eqIdx + 1).trim();
    if (!name) return;

    let domain = new URL(url).hostname;
    let path = new URL(url).pathname;
    const slash = path.lastIndexOf("/");
    path = slash >= 0 ? path.slice(0, slash) || "/" : "/";

    for (const part of setCookie.split(";").slice(1)) {
      const [k, ...v] = part.trim().split("=");
      const key = k.trim().toLowerCase();
      const val = v.join("=").trim();
      if (key === "domain" && val) domain = this.normalizeDomain(val);
      if (key === "path" && val) path = val;
    }

    this.cookies.set(this.key(name, domain, path), {
      name,
      value,
      domain,
      path,
    });
  }

  setCookie(
    name: string,
    value: string,
    domain: string,
    path = "/"
  ): void {
    this.cookies.set(this.key(name, domain, path), {
      name,
      value,
      domain: this.normalizeDomain(domain),
      path,
    });
  }

  cookieHeaderFor(url: string): string {
    const u = new URL(url);
    const parts: string[] = [];
    for (const c of this.cookies.values()) {
      if (
        this.domainMatches(c.domain, u.hostname) &&
        this.pathMatches(c.path, u.pathname)
      ) {
        parts.push(`${c.name}=${c.value}`);
      }
    }
    return parts.join("; ");
  }

  all(): Cookie[] {
    return Array.from(this.cookies.values());
  }

  serialize(): string {
    return JSON.stringify(this.all());
  }

  static deserialize(data: string): CookieJar {
    const jar = new CookieJar();
    try {
      const cookies = JSON.parse(data) as Cookie[];
      if (!Array.isArray(cookies)) return jar;
      for (const c of cookies) {
        if (c?.name && c.value && c.domain && c.path) {
          jar.cookies.set(jar.key(c.name, c.domain, c.path), {
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
          });
        }
      }
    } catch {}
    return jar;
  }
}

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function fetchWithJar(
  jar: CookieJar,
  url: string,
  options: FetchOptions = {}
): Promise<H2Response> {
  const { timeoutMs = 15000, headers } = options;
  const reqHeaders: Record<string, string> = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    ...(headers ?? {}),
  };
  const existing = jar.cookieHeaderFor(url);
  if (existing) {
    const provided = reqHeaders["cookie"] ?? reqHeaders["Cookie"];
    reqHeaders["cookie"] = provided ? `${existing}; ${provided}` : existing;
  }
  if (options.body !== undefined && !reqHeaders["content-type"]) {
    reqHeaders["content-type"] = "application/x-www-form-urlencoded";
  }

  const res = await h2Fetch(url, {
    method: options.method ?? "GET",
    headers: reqHeaders,
    body: options.body,
    signal: options.signal,
    timeoutMs,
  });

  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const sc of setCookie) {
    jar.addFromSetCookie(sc, res.url || url);
  }
  const rawSetCookie = res.headers.get("set-cookie");
  if (rawSetCookie && setCookie.length === 0) {
    jar.addFromSetCookie(rawSetCookie, res.url || url);
  }
  return res;
}

export interface FollowOptions extends FetchOptions {
  rewriteLocation?: (url: string) => string;
  upgradeHosts?: HostPattern[];
  fallbackToHttp?: boolean;
}

export type HostPattern = string | RegExp;

function hostMatches(hostname: string, pattern: HostPattern): boolean {
  if (pattern instanceof RegExp) return pattern.test(hostname);
  const p = pattern.toLowerCase();
  const h = hostname.toLowerCase();
  if (p.startsWith(".")) return h === p.slice(1) || h.endsWith(p);
  return h === p;
}

export function createHttpsRewriter(
  patterns: HostPattern[]
): (url: string) => string {
  return (url: string): string => {
    if (!url.startsWith("http://")) return url;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return url;
    }
    if (patterns.some((p) => hostMatches(u.hostname, p))) {
      return "https://" + url.slice(7);
    }
    return url;
  };
}

export const CDUT_HOSTS: HostPattern[] = [".cdut.edu.cn"];

export const upgradeCdutToHttps = createHttpsRewriter(CDUT_HOSTS);

export interface UpgradeResult {
  res: H2Response;
  url: string;
  upgraded: boolean;
  fellBack: boolean;
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  const msg = err.message || "";
  return (
    msg.includes("ECONNREFUSED") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("EHOSTUNREACH") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("timeout") ||
    msg.includes("TLS") ||
    msg.includes("certificate") ||
    msg.includes("SSL") ||
    msg.includes("ERR_HTTP2") ||
    msg.includes("fetch failed") ||
    msg.includes("H2 request timeout") ||
    err.name === "AbortError"
  );
}

export async function fetchWithUpgrade(
  jar: CookieJar,
  rawUrl: string,
  options: FetchWithUpgradeOptions = {}
): Promise<UpgradeResult> {
  const {
    upgradeHosts = CDUT_HOSTS,
    fallbackToHttp = true,
    ...fetchOptions
  } = options;

  const rewriter = createHttpsRewriter(upgradeHosts);
  const upgradedUrl = rewriter(rawUrl);
  const wasUpgraded = upgradedUrl !== rawUrl;

  try {
    const res = await fetchWithJar(jar, upgradedUrl, fetchOptions);
    return { res, url: upgradedUrl, upgraded: wasUpgraded, fellBack: false };
  } catch (err) {
    if (!wasUpgraded || !fallbackToHttp || !isNetworkError(err)) {
      throw err;
    }
    const res = await fetchWithJar(jar, rawUrl, fetchOptions);
    return { res, url: rawUrl, upgraded: false, fellBack: true };
  }
}

export interface FetchWithUpgradeOptions extends FetchOptions {
  upgradeHosts?: HostPattern[];
  fallbackToHttp?: boolean;
}

export async function followRedirects(
  jar: CookieJar,
  startUrl: string,
  options: FollowOptions = {},
  maxRedirects = 15
): Promise<{ finalUrl: string; cookies: Cookie[]; steps: number; fellBack: boolean }> {
  const {
    rewriteLocation,
    upgradeHosts = CDUT_HOSTS,
    fallbackToHttp = true,
    ...fetchOptions
  } = options;
  const rewriter = createHttpsRewriter(upgradeHosts);
  let currentUrl = startUrl;
  let steps = 0;
  let didFallback = false;

  while (currentUrl && steps < maxRedirects) {
    const result = await fetchWithUpgrade(jar, currentUrl, {
      ...fetchOptions,
      method: fetchOptions.method ?? "GET",
      upgradeHosts,
      fallbackToHttp,
    });
    if (result.fellBack) didFallback = true;
    steps++;
    const location = result.res.headers.get("location");
    if (!location) {
      await result.res.text().catch(() => {});
      return {
        finalUrl: result.url,
        cookies: jar.all(),
        steps,
        fellBack: didFallback,
      };
    }
    let nextUrl = new URL(location, result.url).toString();
    if (rewriteLocation) nextUrl = rewriteLocation(nextUrl);
    nextUrl = rewriter(nextUrl);
    currentUrl = nextUrl;
  }
  return {
    finalUrl: currentUrl,
    cookies: jar.all(),
    steps,
    fellBack: didFallback,
  };
}

export function upgradeToHttps(url: string): string {
  return url.startsWith("http://") ? "https://" + url.slice(7) : url;
}
