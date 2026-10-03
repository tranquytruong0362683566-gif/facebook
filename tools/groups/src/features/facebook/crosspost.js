import { NATIVE_ADDITIONAL_GROUP_LIMIT } from "../../shared/constants.js";

export const CROSSPOST_STORY_DOC_ID = "28135912886045599";

export const CROSSPOST_RELAY_VARIABLES = Object.freeze({
  referringStoryRenderLocation: null,
  inviteShortLinkKey: null,
  isFeed: false,
  isFundraiser: false,
  isFunFactPost: false,
  isGroup: true,
  isEvent: false,
  isTimeline: false,
  isSocialLearning: false,
  isPageNewsFeed: false,
  isProfileReviews: false,
  isWorkSharedDraft: false,
  __relay_internal__pv__CometUFIShareActionMigrationrelayprovider: true,
  __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider: true,
  __relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider: true,
  __relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider: true,
  __relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider: "AUTO_TRANSLATE",
  __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
  __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: true,
  __relay_internal__pv__IsWorkUserrelayprovider: false,
  __relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider: false,
  __relay_internal__pv__CometUFISingleLineUFIrelayprovider: true,
  __relay_internal__pv__CometFeedStory_enable_reactor_facepilerelayprovider: false,
  __relay_internal__pv__CometFeedStory_enable_social_bubblesrelayprovider: false,
  __relay_internal__pv__CometFeedStory_enable_post_permalink_white_space_clickrelayprovider: false,
  __relay_internal__pv__TestPilotShouldIncludeDemoAdUseCaserelayprovider: false,
  __relay_internal__pv__FBReels_deprecate_short_form_video_context_gkrelayprovider: true,
  __relay_internal__pv__FBReels_enable_view_dubbed_audio_type_gkrelayprovider: true,
  __relay_internal__pv__CometFeedShareMedia_shouldPrefetchShareImagerelayprovider: true,
  __relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider: false,
  __relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider: false,
  __relay_internal__pv__IsMergQAPollsrelayprovider: false,
  __relay_internal__pv__FBReelsMediaFooter_comet_enable_reels_ads_gkrelayprovider: true,
  __relay_internal__pv__relay_provider_comet_ufi_ssr_seo_deferrelayprovider: true,
  __relay_internal__pv__ReelsIFUCard_reelsIFULikeCountrelayprovider: false,
  __relay_internal__pv__FBReelsIFUTileContent_reelsIFUPlayOnHoverrelayprovider: true,
  __relay_internal__pv__GroupsCometGYSJFeedItemHeightrelayprovider: 206,
  __relay_internal__pv__ShouldEnableBakedInTextStoriesrelayprovider: false,
  __relay_internal__pv__StoriesShouldIncludeFbNotesrelayprovider: true,
  __relay_internal__pv__groups_comet_use_glvrelayprovider: false,
  __relay_internal__pv__GHLShouldChangeSponsoredAuctionDistanceFieldNamerelayprovider: true,
  __relay_internal__pv__GHLShouldUseSponsoredAuctionLabelFieldNameV1relayprovider: true,
  __relay_internal__pv__GHLShouldUseSponsoredAuctionLabelFieldNameV2relayprovider: false
});

const CROSSPOST_ENVELOPE_VARIABLES = Object.freeze({
  feedLocation: "GROUP",
  feedbackSource: 0,
  focusCommentID: null,
  gridMediaWidth: null,
  groupID: null,
  scale: 1,
  privacySelectorRenderLocation: "COMET_STREAM",
  checkPhotosToReelsUpsellEligibility: false,
  renderLocation: "group",
  useDefaultActor: false
});

const CROSSPOST_INPUT_KEYS = new Set([
  "composer_entry_point",
  "composer_source_surface",
  "composer_type",
  "logging",
  "source",
  "message",
  "with_tags_ids",
  "inline_activities",
  "text_format_preset_id",
  "groups_schedule_xposting",
  "group_flair",
  "attachments",
  "composed_text",
  "navigation_data",
  "tracking",
  "event_share_metadata",
  "audience",
  "actor_id",
  "client_mutation_id"
]);

function crosspostValueError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function normalizeCrosspostGroupIds(baseGroupId, values = []) {
  const baseId = String(baseGroupId || "");
  if (!/^\d+$/.test(baseId)) {
    throw crosspostValueError("INVALID_BASE_GROUP", "UID nhóm gốc không hợp lệ.");
  }
  const output = [];
  const seen = new Set([baseId]);
  for (const value of values) {
    const id = String(value?.id || value || "");
    if (!/^\d+$/.test(id)) {
      throw crosspostValueError("INVALID_CROSSPOST_GROUP", `UID nhóm bổ sung không hợp lệ: ${id || "trống"}.`);
    }
    if (seen.has(id)) continue;
    seen.add(id);
    output.push(id);
  }
  if (output.length > NATIVE_ADDITIONAL_GROUP_LIMIT) {
    throw crosspostValueError(
      "CROSSPOST_GROUP_LIMIT",
      `Facebook chỉ cho thêm tối đa ${NATIVE_ADDITIONAL_GROUP_LIMIT} nhóm bổ sung.`
    );
  }
  return output;
}

export function splitCrosspostGroupBatches(values = []) {
  const groups = [];
  const seen = new Set();
  for (const candidate of Array.isArray(values) ? values : []) {
    const id = String(candidate?.id || "");
    const name = String(candidate?.name || "").trim();
    if (!/^\d+$/.test(id) || !name) {
      throw crosspostValueError("INVALID_CROSSPOST_GROUP", "Danh sách nhóm có UID hoặc tên không hợp lệ.");
    }
    if (seen.has(id)) continue;
    seen.add(id);
    groups.push({ id, name });
  }
  if (groups.length === 0) {
    throw crosspostValueError("CROSSPOST_GROUPS_EMPTY", "Chưa chọn nhóm để đăng bài.");
  }
  const batchSize = NATIVE_ADDITIONAL_GROUP_LIMIT + 1;
  const batches = [];
  for (let index = 0; index < groups.length; index += batchSize) {
    batches.push(groups.slice(index, index + batchSize));
  }
  return batches;
}

export function applyCrosspostGroups(variables, baseGroupId, values, message = "") {
  if (!variables?.input || typeof variables.input !== "object") {
    throw crosspostValueError("INVALID_STORY_VARIABLES", "Biến đăng bài không có input hợp lệ.");
  }
  const baseId = String(baseGroupId || "");
  const groupIds = normalizeCrosspostGroupIds(baseId, values);
  variables.input.audience = { to_id: baseId };
  variables.input.groups_schedule_xposting = groupIds.map((id) => ({
    xpost_audience: { to_id: id }
  }));
  variables.input.group_flair ||= { flair_id: null };
  variables.input.navigation_data ||= {
    attribution_id_v2: `CometGroupDiscussionRoot.react,comet.group,via_cold_start,${Date.now()},0,2361831622,,`
  };
  variables.input.tracking ||= [null];
  variables.input.event_share_metadata ||= { surface: "newsfeed" };
  variables.input.composed_text ||= {
    block_data: ["{}"],
    block_depths: [0],
    block_types: [0],
    blocks: [String(message || "")],
    entities: ["[]"],
    entity_map: "{}",
    inline_styles: ["[]"]
  };
  variables.input.client_mutation_id = "1";
  for (const key of Object.keys(variables.input)) {
    if (!CROSSPOST_INPUT_KEYS.has(key)) delete variables.input[key];
  }
  for (const key of Object.keys(variables)) {
    if (key !== "input") delete variables[key];
  }
  Object.assign(variables, CROSSPOST_ENVELOPE_VARIABLES, CROSSPOST_RELAY_VARIABLES);
  return variables;
}
