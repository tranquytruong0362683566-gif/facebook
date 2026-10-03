export function getManagedPages(...args){return window.TqtSuiteClient.api('pagesApi','getManagedPages',args);}
export function getDirectPage(...args){return window.TqtSuiteClient.api('pagesApi','getDirectPage',args);}
export function getPageStatistics(...args){return window.TqtSuiteClient.api('pagesApi','getPageStatistics',args);}
export function uploadPageVideo(...args){return window.TqtSuiteClient.api('pagesApi','uploadPageVideo',args);}
export function uploadPagePhoto(...args){return window.TqtSuiteClient.api('pagesApi','uploadPagePhoto',args);}
export function waitForPageVideo(...args){return window.TqtSuiteClient.api('pagesApi','waitForPageVideo',args);}
export function publishPageVideo(...args){return window.TqtSuiteClient.api('pagesApi','publishPageVideo',args);}
export function commentOnPublishedVideo(...args){return window.TqtSuiteClient.api('pagesApi','commentOnPublishedVideo',args);}
export function isAuthenticationError(error) {
  return Number(error?.facebookCode) === 190;
}
