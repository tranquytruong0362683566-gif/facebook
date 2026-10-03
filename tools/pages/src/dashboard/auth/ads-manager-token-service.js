export class AdsManagerTokenError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "AdsManagerTokenError";
    this.code = code || "ADS_MANAGER_TOKEN_ERROR";
    this.httpStatus = options.httpStatus ?? null;
    this.verificationRequired = Boolean(options.verificationRequired);
  }
}

export function fetchUserTokenFromAdsManager(){return window.TqtSuiteClient.api('pagesAuth','fetchUserTokenFromAdsManager',[]);}
