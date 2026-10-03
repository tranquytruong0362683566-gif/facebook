import {classifyFacebookError} from './facebook-errors.js';
export {classifyFacebookError};
export function readFacebookSession(){return window.TqtSuiteClient.api('groupsApi','readFacebookSession',[]);}
export function extractLinks(message){return Array.from(new Set(String(message||'').match(/(?:https?:\/\/|www\.)\S+/g)||[])).map(url=>/^https?:/.test(url)?url:'https://'+url);}
export class FacebookApi {
  constructor(profile){this.profile=profile;this.instance=crypto.randomUUID();}
  setProfile(profile){this.profile=profile;}
  setToken(token){this.profile.fb_dtsg=token;}
}
FacebookApi.prototype.verifyPublishedPost=function(...args){return window.TqtSuiteClient.api('groupsApi','verifyPublishedPost',args,{instance:this.instance,profile:this.profile});};
FacebookApi.prototype.verifyPublishedGroups=function(...args){return window.TqtSuiteClient.api('groupsApi','verifyPublishedGroups',args,{instance:this.instance,profile:this.profile});};
FacebookApi.prototype.fetchGroups=function(...args){return window.TqtSuiteClient.api('groupsApi','fetchGroups',args,{instance:this.instance,profile:this.profile});};
FacebookApi.prototype.getLinkPreview=function(...args){return window.TqtSuiteClient.api('groupsApi','getLinkPreview',args,{instance:this.instance,profile:this.profile});};
FacebookApi.prototype.postText=function(...args){return window.TqtSuiteClient.api('groupsApi','postText',args,{instance:this.instance,profile:this.profile});};
FacebookApi.prototype.postLink=function(...args){return window.TqtSuiteClient.api('groupsApi','postLink',args,{instance:this.instance,profile:this.profile});};
FacebookApi.prototype.uploadPhoto=function(...args){return window.TqtSuiteClient.api('groupsApi','uploadPhoto',args,{instance:this.instance,profile:this.profile});};
FacebookApi.prototype.postPhoto=function(...args){return window.TqtSuiteClient.api('groupsApi','postPhoto',args,{instance:this.instance,profile:this.profile});};
FacebookApi.prototype.postVideo=function(...args){return window.TqtSuiteClient.api('groupsApi','postVideo',args,{instance:this.instance,profile:this.profile});};
FacebookApi.prototype.abortActiveVideo=function(...args){return window.TqtSuiteClient.api('groupsApi','abortActiveVideo',args,{instance:this.instance,profile:this.profile});};
FacebookApi.prototype.publish=function(...args){return window.TqtSuiteClient.api('groupsApi','publish',args,{instance:this.instance,profile:this.profile});};
FacebookApi.prototype.publishMultiGroup=function(...args){return window.TqtSuiteClient.api('groupsApi','publishMultiGroup',args,{instance:this.instance,profile:this.profile});};
FacebookApi.prototype.abortMultiGroup=function(...args){return window.TqtSuiteClient.api('groupsApi','abortMultiGroup',args,{instance:this.instance,profile:this.profile});};
