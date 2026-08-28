/** CAS TGT 失效 (被重定向回登录页) 时抛出; 路由层映射为 401 */
export class SessionExpiredError extends Error {
  constructor(message = "CAS 会话已失效，请重新登录") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

export function isSessionExpired(err: unknown): err is SessionExpiredError {
  return err instanceof SessionExpiredError;
}
