# nhentai API v2 — Complete Reference

A single consolidated reference built from the OpenAPI 3.1 specification (`openapi_documentation.json`) and the rendered Swagger UI export (`API_-_Swagger_UI.html`). Both sources describe the same specification revision, `2.0.0+71a8966`, so this document is complete against both.

| | |
|---|---|
| **Specification version** | `2.0.0+71a8966` |
| **OpenAPI version** | `3.1.0` |
| **Base URL** | `https://nhentai.net` |
| **Spec endpoint** | `GET /api/v2/openapi.json` |
| **Endpoints (paths)** | 89 |
| **Operations** | 105 |
| **Schemas** | 117 |
| **Tag groups** | 15 |

> **On examples.** The source specification contains no `example` or `examples` members. Every request and response example in this document is *synthesized from the schema definitions* — field names, types, formats, enums, and declared defaults. Values are illustrative placeholders, not captured live traffic. Structure and field names are authoritative; literal values are not.

---

## Table of contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Conventions](#conventions)
   - [Required headers](#required-headers)
   - [Pagination](#pagination)
   - [Errors and status codes](#errors-and-status-codes)
   - [Rate limiting](#rate-limiting)
   - [Proof of Work and CAPTCHA](#proof-of-work-and-captcha)
   - [Feature flags](#feature-flags)
   - [CDN media paths](#cdn-media-paths)
4. [Endpoint index](#endpoint-index)
5. [Endpoint reference](#endpoint-reference)
   - [Meta / service discovery](#meta-service-discovery)
   - [cdn](#cdn)
   - [galleries](#galleries)
   - [search](#search)
   - [tags](#tags)
   - [comments](#comments)
   - [favorites](#favorites)
   - [blacklist](#blacklist)
   - [users](#users)
   - [user](#user)
   - [auth](#auth)
   - [GTS](#gts)
   - [taxonomy](#taxonomy)
   - [moderation](#moderation)
   - [zones](#zones)
6. [Schema reference](#schema-reference)
7. [Appendices](#appendices)
   - [A. Enum catalogue](#a-enum-catalogue)
   - [B. Search query syntax](#b-search-query-syntax)
   - [C. Rate limit summary](#c-rate-limit-summary)
   - [D. Schema index](#d-schema-index)

---

## Overview

nhentai.net REST API

Generate an API key in your [account settings](https://nhentai.net/user/settings#apikeys), then pass it as `Authorization: Key YOUR_API_KEY`.

Please set a descriptive `User-Agent` header: `AppName/version (contact or project URL)`. This helps us identify traffic and reach out if needed.

Questions or need higher limits? [support@nhentai.net](mailto:support@nhentai.net)

[Changelog](/api/v2/changelog)

All paths in this document are absolute and already include the `/api/v2` prefix, so a full request URL is `https://nhentai.net` + path. The specification declares no `servers` array; the host above is taken from the service description.

---

## Authentication

Two credential types are defined, both passed in the `Authorization` request header. They differ only in prefix.

| Scheme | Type | Header | Value format | Purpose |
|---|---|---|---|---|
| `User Token` | `apiKey` | `Authorization` (`header`) | `User <token>` | Interactive user session (first-party) |
| `API Key` | `apiKey` | `Authorization` (`header`) | `Key <api_key>` | Third-party programmatic access |

```http
Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9
Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0NDIx
```

API keys are generated in [account settings](https://nhentai.net/user/settings#apikeys). Third-party clients should use **API Key** authentication; the `auth` and most `user` endpoints are first-party only and enforced as such.

### Authorisation levels

Each operation declares one of six access levels in its description. Counts across the 105 operations:

| Level | Operations | Meaning |
|---|---|---|
| Staff Token required | 31 | User Token belonging to a staff account. |
| Public (no authentication required) | 22 | No credentials accepted or needed. |
| User Token required | 22 | Interactive session token only. |
| Public (optional User Token or API Key for personalization) | 15 | Works anonymously; supplying credentials personalises the result (favourites, blacklist filtering) and usually raises the rate limit. |
| User Token or API Key | 10 | Either credential type is accepted. |
| Superuser Token required | 5 | User Token belonging to a superuser account. |

---

## Conventions

### Required headers

| Header | Required | Notes |
|---|---|---|
| `Authorization` | Per-endpoint | `Key <api_key>` or `User <token>`. See [Authentication](#authentication). |
| `User-Agent` | Strongly requested | Use a descriptive value: `AppName/version (contact or project URL)`. Identifies your traffic and lets the operators contact you. |
| `Content-Type` | On request bodies | `application/json`, except avatar upload which uses `multipart/form-data`. |

### Pagination

List endpoints use 1-based page numbers via a `page` query parameter, and return a wrapper object: [`PaginatedResponse_GalleryListItem_`](#schema-paginatedresponse-gallerylistitem-), [`PaginatedResponse_CommentResponse_`](#schema-paginatedresponse-commentresponse-), or [`TagPaginatedResponse`](#schema-tagpaginatedresponse).

| Field | Meaning |
|---|---|
| `result` | The page of items. |
| `num_pages` | Total number of pages available. |
| `per_page` | Items per page (default `25`). |
| `total` | Total matching items; may be `null` when the count is unavailable or not computed. |

Iterate by requesting `page=1..num_pages`. Treat `total: null` as "unknown" rather than zero.

### Errors and status codes

Errors are returned as JSON. Three error shapes exist:

- [`ErrorResponse`](#schema-errorresponse) — general errors (`4xx`/`5xx`).
- [`HTTPValidationError`](#schema-httpvalidationerror) — `422`, wrapping a list of [`ValidationError`](#schema-validationerror) entries that pinpoint the offending field via `loc`.
- [`CaptchaErrorResponse`](#schema-captchaerrorresponse) — a challenge is required before the request can proceed.

Status codes appearing across the specification, with the number of operations that document each:

| Code | Operations | Meaning |
|---|---|---|
| `200` | 105 | Success. |
| `302` | 1 | See the individual operation. |
| `400` | 25 | Malformed request or invalid parameter combination. |
| `401` | 21 | Missing, malformed, or expired credentials. |
| `403` | 38 | Authenticated but not permitted (insufficient role, or disabled feature flag). |
| `404` | 47 | Resource does not exist, or is hidden from you. |
| `409` | 12 | Conflict with current state (e.g. duplicate). |
| `413` | 1 | See the individual operation. |
| `422` | 91 | Request validated but a field failed constraints. Body is a validation error. |
| `429` | 83 | Rate limit exceeded. Back off and retry later. |
| `502` | 1 | See the individual operation. |
| `503` | 29 | Service temporarily unavailable. |

### Rate limiting

Limits are documented per operation in the form `count/window per scope`, where scope is `IP`, `user`, or `API key owner`. Several endpoints declare **different limits per authentication level or per parameter value** — for example the download endpoint is stricter for `format=torrent` than for `zip`/`cbz`, and search allows 10/min anonymously versus 20/min authenticated.

When more than one scope is listed, **all** of them apply simultaneously; the first to trip returns `429`. Treat `429` as a backoff signal and retry with increasing delay rather than immediately. See [Appendix C](#c-rate-limit-summary) for the full table.

### Proof of Work and CAPTCHA

Some unauthenticated endpoints — chiefly account creation, login, and password reset — are gated behind an anti-abuse challenge, declared as `Protection:` in the operation description.

1. **Proof of Work.** Call `GET /api/v2/pow?action=<action>` to obtain a [`PoWChallengeResponse`](#schema-powchallengeresponse) challenge, solve it, and submit the solution with the protected request.
2. **CAPTCHA.** Call `GET /api/v2/captcha` for provider details ([`CaptchaInfoResponse`](#schema-captchainforesponse)) and include the resulting token. A request that needs a challenge it did not supply is answered with [`CaptchaErrorResponse`](#schema-captchaerrorresponse).

Declared protections:

| Protection | Operations |
|---|---|
| CAPTCHA required (`GET /api/v2/captcha` for provider info) | 9 |
| Proof of Work required (`GET /api/v2/pow?action=reset`) | 2 |
| Proof of Work required (`GET /api/v2/pow?action=gts_create`) | 1 |
| Proof of Work required (`GET /api/v2/pow?action=gts_vote`) | 1 |
| Proof of Work required (`GET /api/v2/pow?action=taxonomy_create`) | 1 |
| Proof of Work required (`GET /api/v2/pow?action=taxonomy_comment`) | 1 |
| Proof of Work required (`GET /api/v2/pow?action=taxonomy_vote`) | 1 |
| Proof of Work required (`GET /api/v2/pow?action=comment`) | 1 |
| Proof of Work required (`GET /api/v2/pow?action=api_key`) | 1 |
| Proof of Work required (`GET /api/v2/pow?action=login`) | 1 |
| Proof of Work required (`GET /api/v2/pow?action=register`) | 1 |

### Feature flags

29 operations are gated on a server-side feature flag, declared as `Feature Flag:` in the description. If the flag is disabled the endpoint rejects the request regardless of credentials. Current flag values are exposed by `GET /api/v2/config` ([`ConfigResponse`](#schema-configresponse)); check them rather than assuming an endpoint is available.

| Flag | Operations gated |
|---|---|
| `allow_taxonomy` | 13 |
| `allow_gts` | 6 |
| `allow_favorites` | 2 |
| `allow_comments` | 2 |
| `allow_api_keys` | 2 |
| `allow_password_reset` | 2 |
| `allow_downloads` | 1 |
| `allow_register` | 1 |

### CDN media paths

Gallery and thumbnail `path` values are relative. Fetch available servers from `GET /api/v2/cdn` and concatenate one with the `path` to form a full URL. **Don't hardcode specific subdomains;** the list can change.

**Use the `path` exactly as returned.** Don't construct paths by guessing extensions, suffixes, or numbering. The CDN strictly validates URL patterns and silently rejects anything that doesn't match a known media route. Clients that do this repeatedly will eventually receive an **extended ban**.

Rate limits are generous for normal browsing. Brief bursts (like loading a full gallery's thumbnails at once) are absorbed without `429`s. Clients that sustain rates well beyond typical browsing, or repeatedly request invalid URL patterns, will be **temporarily banned**. Bans are short and self-expiring. **Treat `429` as a backoff signal.**

**Note: full-gallery archives have a dedicated endpoint at `POST /api/v2/galleries/{id}/download`. Don't reconstruct them by walking page URLs on the CDN.**

In practice: fetch the server list once from `GET /api/v2/cdn` ([`CdnConfigResponse`](#schema-cdnconfigresponse)), pick a host, and concatenate it with the relative `path` value exactly as returned by the API.

```
<cdn_host> + <path>   →   https://<cdn_host>/galleries/2841902/3.webp
```

---

## Endpoint index

All 105 operations. "Auth" is the declared access level; "Flag" marks a feature-flag gate; "PoW/CAP" marks an anti-abuse challenge.

| Method | Path | Summary | Auth | Flag | PoW/CAP | Group |
|---|---|---|---|---|---|---|
| `GET` | [`/api/v2`](#get-apiv2) | Api Root | Public |  |  | (meta) |
| `GET` | [`/api/v2/pow`](#get-apiv2pow) | Get Pow Challenge | Public |  |  | (meta) |
| `GET` | [`/api/v2/config`](#get-apiv2config) | Get Config | Public |  |  | (meta) |
| `GET` | [`/api/v2/captcha`](#get-apiv2captcha) | Get Captcha Info | Public |  |  | (meta) |
| `GET` | [`/api/v2/cdn`](#get-apiv2cdn) | Get Cdn Config | Public |  |  | cdn |
| `GET` | [`/api/v2/galleries`](#get-apiv2galleries) | Get All Galleries | Public (opt.) |  |  | galleries |
| `GET` | [`/api/v2/galleries/tagged`](#get-apiv2galleriestagged) | Get Galleries By Tag | Public (opt.) |  |  | galleries |
| `GET` | [`/api/v2/galleries/popular`](#get-apiv2galleriespopular) | Get Popular Galleries | Public (opt.) |  |  | galleries |
| `GET` | [`/api/v2/galleries/random`](#get-apiv2galleriesrandom) | Get Random Gallery | Public (opt.) |  |  | galleries |
| `GET` | [`/api/v2/galleries/{gallery_id}`](#get-apiv2galleriesgallery-id) | Get Gallery | Public (opt.) |  |  | galleries |
| `GET` | [`/api/v2/galleries/{gallery_id}/related`](#get-apiv2galleriesgallery-idrelated) | Get Related Galleries | Public (opt.) |  |  | galleries |
| `GET` | [`/api/v2/galleries/{gallery_id}/favorite`](#get-apiv2galleriesgallery-idfavorite) | Check Favorite | User / Key |  |  | galleries |
| `POST` | [`/api/v2/galleries/{gallery_id}/favorite`](#post-apiv2galleriesgallery-idfavorite) | Add To Favorites | User / Key | ✅ |  | galleries |
| `DELETE` | [`/api/v2/galleries/{gallery_id}/favorite`](#delete-apiv2galleriesgallery-idfavorite) | Remove From Favorites | User / Key | ✅ |  | galleries |
| `POST` | [`/api/v2/galleries/{gallery_id}/edit`](#post-apiv2galleriesgallery-idedit) | Submit Gallery Edit | Staff |  |  | galleries |
| `POST` | [`/api/v2/galleries/{gallery_id}/download`](#post-apiv2galleriesgallery-iddownload) | Get a download URL for a gallery | User / Key | ✅ |  | galleries |
| `GET` | [`/api/v2/search`](#get-apiv2search) | Search Galleries | Public (opt.) |  |  | search |
| `GET` | [`/api/v2/tags/ids`](#get-apiv2tagsids) | Get Tags By Ids | Public |  |  | tags |
| `POST` | [`/api/v2/tags/search`](#post-apiv2tagssearch) | Search Tags | Public |  |  | tags |
| `GET` | [`/api/v2/tags/{tag_type}`](#get-apiv2tagstag-type) | Get Tags By Type | Public |  |  | tags |
| `GET` | [`/api/v2/tags/{tag_type}/{slug}`](#get-apiv2tagstag-typeslug) | Get Tag By Slug | Public |  |  | tags |
| `GET` | [`/api/v2/galleries/{gallery_id}/comments`](#get-apiv2galleriesgallery-idcomments) | Get Gallery Comments | Public (opt.) |  |  | comments |
| `POST` | [`/api/v2/galleries/{gallery_id}/comments`](#post-apiv2galleriesgallery-idcomments) | Create Comment | User | ✅ | ✅ | comments |
| `GET` | [`/api/v2/galleries/{gallery_id}/comments/count`](#get-apiv2galleriesgallery-idcommentscount) | Get Gallery Comment Count | Public |  |  | comments |
| `DELETE` | [`/api/v2/comments/{comment_id}`](#delete-apiv2commentscomment-id) | Delete Comment | User | ✅ |  | comments |
| `POST` | [`/api/v2/comments/{comment_id}/flag`](#post-apiv2commentscomment-idflag) | Flag Comment | User |  |  | comments |
| `GET` | [`/api/v2/favorites`](#get-apiv2favorites) | Get Favorites | User / Key |  |  | favorites |
| `GET` | [`/api/v2/favorites/random`](#get-apiv2favoritesrandom) | Get Random Favorite | User / Key |  |  | favorites |
| `GET` | [`/api/v2/blacklist`](#get-apiv2blacklist) | Get Blacklist | User / Key |  |  | blacklist |
| `POST` | [`/api/v2/blacklist`](#post-apiv2blacklist) | Update Blacklist | User / Key |  |  | blacklist |
| `GET` | [`/api/v2/blacklist/ids`](#get-apiv2blacklistids) | Get Blacklist Ids | User / Key |  |  | blacklist |
| `GET` | [`/api/v2/users/{user_id}/{slug}`](#get-apiv2usersuser-idslug) | Get User Profile | Public (opt.) |  |  | users |
| `GET` | [`/api/v2/user`](#get-apiv2user) | Get Me | User / Key |  |  | user |
| `PUT` | [`/api/v2/user`](#put-apiv2user) | Update Profile | User |  |  | user |
| `DELETE` | [`/api/v2/user`](#delete-apiv2user) | Delete Account | User |  |  | user |
| `POST` | [`/api/v2/user/avatar`](#post-apiv2useravatar) | Upload Avatar | User |  |  | user |
| `GET` | [`/api/v2/user/keys`](#get-apiv2userkeys) | List Api Keys | User |  |  | user |
| `POST` | [`/api/v2/user/keys`](#post-apiv2userkeys) | Create Api Key | User | ✅ | ✅ | user |
| `DELETE` | [`/api/v2/user/keys/{key_id}`](#delete-apiv2userkeyskey-id) | Revoke Api Key | User | ✅ |  | user |
| `POST` | [`/api/v2/auth/login`](#post-apiv2authlogin) | Login | Public |  | ✅ | auth |
| `POST` | [`/api/v2/auth/register`](#post-apiv2authregister) | Register | Public | ✅ | ✅ | auth |
| `POST` | [`/api/v2/auth/refresh`](#post-apiv2authrefresh) | Refresh | Public |  |  | auth |
| `POST` | [`/api/v2/auth/logout`](#post-apiv2authlogout) | Logout | User |  |  | auth |
| `POST` | [`/api/v2/auth/logout/all`](#post-apiv2authlogoutall) | Logout All | User |  |  | auth |
| `GET` | [`/api/v2/auth/sessions`](#get-apiv2authsessions) | Get Sessions | User |  |  | auth |
| `DELETE` | [`/api/v2/auth/sessions/{session_id}`](#delete-apiv2authsessionssession-id) | Revoke Session | User |  |  | auth |
| `POST` | [`/api/v2/auth/reset`](#post-apiv2authreset) | Request Password Reset | Public | ✅ | ✅ | auth |
| `POST` | [`/api/v2/auth/reset/confirm`](#post-apiv2authresetconfirm) | Confirm Password Reset | Public | ✅ | ✅ | auth |
| `GET` | [`/api/v2/galleries/{gallery_id}/suggestions`](#get-apiv2galleriesgallery-idsuggestions) | List Gallery Suggestions | Public (opt.) | ✅ |  | GTS |
| `POST` | [`/api/v2/galleries/{gallery_id}/suggestions`](#post-apiv2galleriesgallery-idsuggestions) | Create Suggestion | User | ✅ | ✅ | GTS |
| `GET` | [`/api/v2/gts/backlog`](#get-apiv2gtsbacklog) | List Gts Backlog | Public (opt.) | ✅ |  | GTS |
| `GET` | [`/api/v2/gts/new-tags`](#get-apiv2gtsnew-tags) | List New Tag Index | Public | ✅ |  | GTS |
| `POST` | [`/api/v2/galleries/{gallery_id}/suggestions/{suggestion_id}/vote`](#post-apiv2galleriesgallery-idsuggestionssuggestion-idvote) | Vote On Suggestion | User | ✅ | ✅ | GTS |
| `DELETE` | [`/api/v2/galleries/{gallery_id}/suggestions/{suggestion_id}`](#delete-apiv2galleriesgallery-idsuggestionssuggestion-id) | Withdraw Suggestion | User | ✅ |  | GTS |
| `GET` | [`/api/v2/moderation/gts`](#get-apiv2moderationgts) | List Pending Suggestions | Staff |  |  | GTS |
| `POST` | [`/api/v2/moderation/gts/{suggestion_id}/accept`](#post-apiv2moderationgtssuggestion-idaccept) | Accept Suggestion | Staff |  |  | GTS |
| `POST` | [`/api/v2/moderation/gts/{suggestion_id}/reject`](#post-apiv2moderationgtssuggestion-idreject) | Reject Suggestion | Staff |  |  | GTS |
| `POST` | [`/api/v2/moderation/gts/{suggestion_id}/revert`](#post-apiv2moderationgtssuggestion-idrevert) | Revert Suggestion | Staff |  |  | GTS |
| `POST` | [`/api/v2/moderation/tags`](#post-apiv2moderationtags) | Moderation Create Tag | Staff |  |  | GTS |
| `GET` | [`/api/v2/taxonomy`](#get-apiv2taxonomy) | List Taxonomy Suggestions | Public (opt.) | ✅ |  | taxonomy |
| `POST` | [`/api/v2/taxonomy`](#post-apiv2taxonomy) | Create Taxonomy Suggestion | User | ✅ | ✅ | taxonomy |
| `GET` | [`/api/v2/taxonomy/stats`](#get-apiv2taxonomystats) | Get Taxonomy Suggestion Stats | Public | ✅ |  | taxonomy |
| `GET` | [`/api/v2/taxonomy/resolved`](#get-apiv2taxonomyresolved) | List Resolved Taxonomy Suggestions | Public (opt.) | ✅ |  | taxonomy |
| `GET` | [`/api/v2/taxonomy/{suggestion_id}`](#get-apiv2taxonomysuggestion-id) | Get Taxonomy Suggestion | Public (opt.) | ✅ |  | taxonomy |
| `DELETE` | [`/api/v2/taxonomy/{suggestion_id}`](#delete-apiv2taxonomysuggestion-id) | Remove Taxonomy Suggestion | User | ✅ |  | taxonomy |
| `PATCH` | [`/api/v2/taxonomy/{suggestion_id}`](#patch-apiv2taxonomysuggestion-id) | Edit Taxonomy Suggestion | User | ✅ |  | taxonomy |
| `GET` | [`/api/v2/taxonomy/{suggestion_id}/comments`](#get-apiv2taxonomysuggestion-idcomments) | List Taxonomy Comments | Public (opt.) | ✅ |  | taxonomy |
| `POST` | [`/api/v2/taxonomy/{suggestion_id}/comments`](#post-apiv2taxonomysuggestion-idcomments) | Create Taxonomy Comment | User | ✅ | ✅ | taxonomy |
| `DELETE` | [`/api/v2/taxonomy/{suggestion_id}/comments/{comment_id}`](#delete-apiv2taxonomysuggestion-idcommentscomment-id) | Delete Taxonomy Comment | User | ✅ |  | taxonomy |
| `POST` | [`/api/v2/taxonomy/{suggestion_id}/vote`](#post-apiv2taxonomysuggestion-idvote) | Vote On Taxonomy Suggestion | User | ✅ | ✅ | taxonomy |
| `GET` | [`/api/v2/taxonomy/{suggestion_id}/edits`](#get-apiv2taxonomysuggestion-idedits) | List Taxonomy Edits | Public | ✅ |  | taxonomy |
| `POST` | [`/api/v2/moderation/taxonomy/{suggestion_id}/accept`](#post-apiv2moderationtaxonomysuggestion-idaccept) | Accept Taxonomy Suggestion | Staff |  |  | taxonomy |
| `DELETE` | [`/api/v2/moderation/taxonomy/{suggestion_id}`](#delete-apiv2moderationtaxonomysuggestion-id) | Delete Taxonomy Suggestion | Superuser | ✅ |  | taxonomy |
| `POST` | [`/api/v2/moderation/taxonomy/{suggestion_id}/reject`](#post-apiv2moderationtaxonomysuggestion-idreject) | Reject Taxonomy Suggestion | Staff |  |  | taxonomy |
| `GET` | [`/api/v2/moderation/users/{user_id}`](#get-apiv2moderationusersuser-id) | Get User Mod Info | Staff |  |  | moderation |
| `DELETE` | [`/api/v2/moderation/users/{user_id}`](#delete-apiv2moderationusersuser-id) | Delete User | Staff |  |  | moderation |
| `PUT` | [`/api/v2/moderation/users/{user_id}/shadowban`](#put-apiv2moderationusersuser-idshadowban) | Shadowban User | Staff |  |  | moderation |
| `DELETE` | [`/api/v2/moderation/users/{user_id}/shadowban`](#delete-apiv2moderationusersuser-idshadowban) | Unshadowban User | Staff |  |  | moderation |
| `GET` | [`/api/v2/moderation/galleries/hidden`](#get-apiv2moderationgallerieshidden) | List Hidden Galleries | Staff |  |  | moderation |
| `GET` | [`/api/v2/moderation/galleries/{gallery_id}`](#get-apiv2moderationgalleriesgallery-id) | Get Gallery Mod Info | Staff |  |  | moderation |
| `PUT` | [`/api/v2/moderation/galleries/{gallery_id}/hidden`](#put-apiv2moderationgalleriesgallery-idhidden) | Hide Gallery | Staff |  |  | moderation |
| `DELETE` | [`/api/v2/moderation/galleries/{gallery_id}/hidden`](#delete-apiv2moderationgalleriesgallery-idhidden) | Unhide Gallery | Staff |  |  | moderation |
| `POST` | [`/api/v2/comments/flags/{flag_id}/review`](#post-apiv2commentsflagsflag-idreview) | Review Comment Flag | Staff |  |  | moderation |
| `GET` | [`/api/v2/moderation/flags`](#get-apiv2moderationflags) | Get Pending Flags | Staff |  |  | moderation |
| `GET` | [`/api/v2/moderation/edits`](#get-apiv2moderationedits) | Get Pending Edits | Staff |  |  | moderation |
| `GET` | [`/api/v2/moderation/edits/{edit_id}`](#get-apiv2moderationeditsedit-id) | Get Edit | Staff |  |  | moderation |
| `POST` | [`/api/v2/moderation/edits/{edit_id}/vote`](#post-apiv2moderationeditsedit-idvote) | Vote On Edit | Staff |  |  | moderation |
| `POST` | [`/api/v2/moderation/edits/{edit_id}/apply`](#post-apiv2moderationeditsedit-idapply) | Apply Edit | Staff |  |  | moderation |
| `POST` | [`/api/v2/moderation/edits/{edit_id}/reject`](#post-apiv2moderationeditsedit-idreject) | Reject Edit | Staff |  |  | moderation |
| `GET` | [`/api/v2/moderation/comments/recent`](#get-apiv2moderationcommentsrecent) | Get Recent Comments | Superuser |  |  | moderation |
| `GET` | [`/api/v2/moderation/comments/spam`](#get-apiv2moderationcommentsspam) | Get Spam Comments | Superuser |  |  | moderation |
| `PUT` | [`/api/v2/moderation/comments/{comment_id}/hide`](#put-apiv2moderationcommentscomment-idhide) | Hide Comment | Staff |  |  | moderation |
| `DELETE` | [`/api/v2/moderation/comments/{comment_id}/hide`](#delete-apiv2moderationcommentscomment-idhide) | Unhide Comment | Staff |  |  | moderation |
| `POST` | [`/api/v2/moderation/bulk/hide`](#post-apiv2moderationbulkhide) | Bulk Hide | Staff |  |  | moderation |
| `POST` | [`/api/v2/moderation/bulk/unhide`](#post-apiv2moderationbulkunhide) | Bulk Unhide | Staff |  |  | moderation |
| `POST` | [`/api/v2/moderation/bulk/shadowban`](#post-apiv2moderationbulkshadowban) | Bulk Shadowban | Staff |  |  | moderation |
| `POST` | [`/api/v2/moderation/bulk/unshadowban`](#post-apiv2moderationbulkunshadowban) | Bulk Unshadowban | Staff |  |  | moderation |
| `GET` | [`/api/v2/moderation/api-keys`](#get-apiv2moderationapi-keys) | List All Api Keys | Superuser |  |  | moderation |
| `DELETE` | [`/api/v2/moderation/api-keys/{key_id}`](#delete-apiv2moderationapi-keyskey-id) | Revoke Api Key Admin | Superuser |  |  | moderation |
| `GET` | [`/api/v2/moderation/spam/config`](#get-apiv2moderationspamconfig) | Get Spam Config | Staff |  |  | moderation |
| `PUT` | [`/api/v2/moderation/spam/config/{name}`](#put-apiv2moderationspamconfigname) | Update Spam Config | Staff |  |  | moderation |
| `GET` | [`/api/v2/zones`](#get-apiv2zones) | Get Zones | Public |  |  | zones |
| `GET` | [`/api/v2/zones/i`](#get-apiv2zonesi) | Get Popunder Inventory | Public |  |  | zones |
| `POST` | [`/api/v2/zones/h`](#post-apiv2zonesh) | Record Popunder Hit | Public |  |  | zones |
| `GET` | [`/api/v2/zones/pu`](#get-apiv2zonespu) | Popunder Redirect | Public |  |  | zones |

---

## Endpoint reference

### Meta / service discovery

Untagged service-level endpoints: API root, runtime configuration, and the anti-abuse challenge providers.

*4 operations.*

<a id="get-apiv2"></a>

#### `GET` `/api/v2`

**Api Root**

API root.

| | |
|---|---|
| **Operation ID** | `api_root_api_v2_get` |
| **Auth** | Public (no authentication required) |
| **Security schemes** | None declared |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`ApiRootResponse`](#schema-apirootresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)'
```

**Example response** — `200`

```json
{
  "version": "string",
  "message": "Thanks for the upload!"
}
```

---

<a id="get-apiv2pow"></a>

#### `GET` `/api/v2/pow`

**Get Pow Challenge**

Get a new proof of work challenge. Optionally specify action for per-action difficulty.

| | |
|---|---|
| **Operation ID** | `get_pow_challenge_api_v2_pow_get` |
| **Auth** | Public (no authentication required) |
| **Security schemes** | None declared |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `action` | `string` *(nullable)* | no | — | Action |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`PoWChallengeResponse`](#schema-powchallengeresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/pow' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)'
```

**Example response** — `200`

```json
{
  "challenge": "string",
  "difficulty": 1
}
```

---

<a id="get-apiv2config"></a>

#### `GET` `/api/v2/config`

**Get Config**

Get app config: CDN servers and current announcement.

| | |
|---|---|
| **Operation ID** | `get_config_api_v2_config_get` |
| **Auth** | Public (no authentication required) |
| **Security schemes** | None declared |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`ConfigResponse`](#schema-configresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/config' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)'
```

**Example response** — `200`

```json
{
  "image_servers": [
    "string"
  ],
  "thumb_servers": [
    "string"
  ],
  "announcement": {
    "message": "Thanks for the upload!",
    "links": [
      {
        "text": "Thanks for the upload!",
        "url": "https://cdn.example.net/galleries/1451234/3.webp"
      }
    ]
  }
}
```

---

<a id="get-apiv2captcha"></a>

#### `GET` `/api/v2/captcha`

**Get Captcha Info**

Get CAPTCHA provider info for the frontend widget.

| | |
|---|---|
| **Operation ID** | `get_captcha_info_api_v2_captcha_get` |
| **Auth** | Public (no authentication required) |
| **Security schemes** | None declared |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`CaptchaInfoResponse`](#schema-captchainforesponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/captcha' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)'
```

**Example response** — `200`

```json
{
  "provider": "string",
  "site_key": "string"
}
```

---

### cdn

Gallery and thumbnail `path` values are relative. Fetch available servers from `GET /api/v2/cdn` and concatenate one with the `path` to form a full URL. **Don't hardcode specific subdomains;** the list can change.

**Use the `path` exactly as returned.** Don't construct paths by guessing extensions, suffixes, or numbering. The CDN strictly validates URL patterns and silently rejects anything that doesn't match a known media route. Clients that do this repeatedly will eventually receive an **extended ban**.

Rate limits are generous for normal browsing. Brief bursts (like loading a full gallery's thumbnails at once) are absorbed without `429`s. Clients that sustain rates well beyond typical browsing, or repeatedly request invalid URL patterns, will be **temporarily banned**. Bans are short and self-expiring. **Treat `429` as a backoff signal.**

**Note: full-gallery archives have a dedicated endpoint at `POST /api/v2/galleries/{id}/download`. Don't reconstruct them by walking page URLs on the CDN.**

*1 operation.*

<a id="get-apiv2cdn"></a>

#### `GET` `/api/v2/cdn`

**Get Cdn Config**

Get CDN server configuration for media URLs.

| | |
|---|---|
| **Operation ID** | `get_cdn_config_api_v2_cdn_get` |
| **Auth** | Public (no authentication required) |
| **Security schemes** | None declared |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`CdnConfigResponse`](#schema-cdnconfigresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/cdn' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)'
```

**Example response** — `200`

```json
{
  "image_servers": [
    "string"
  ],
  "thumb_servers": [
    "string"
  ]
}
```

---

### galleries

Browse, search, and retrieve gallery data.

*11 operations.*

<a id="get-apiv2galleries"></a>

#### `GET` `/api/v2/galleries`

**Get All Galleries**

Get paginated galleries ordered by newest first.

| | |
|---|---|
| **Operation ID** | `get_all_galleries_api_v2_galleries_get` |
| **Auth** | Public (optional User Token or API Key for personalization) |
| **Security schemes** | `User Token` or `API Key` |
| **Rate limits** | When `auth=anon`: • 15/1min per IP <br> When `auth=user\|key`: • 30/1min per IP |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `page` | `integer` | no | min: `1`; default: `1` | Page number |
| `per_page` | `integer` | no | min: `1`; max: `100`; default: `25` | Items per page |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`PaginatedResponse_GalleryListItem_`](#schema-paginatedresponse-gallerylistitem-) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/galleries?page=1&per_page=25' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
{
  "result": [
    {
      "id": 2841902,
      "media_id": "2841902",
      "english_title": "Example Gallery Title",
      "japanese_title": "サンプルタイトル",
      "thumbnail": "/galleries/2841902/3.webp",
      "thumbnail_width": 1280,
      "thumbnail_height": 1807,
      "num_pages": 24,
      "num_favorites": 12,
      "tag_ids": [
        1234
      ],
      "blacklisted": false
    }
  ],
  "num_pages": 24,
  "per_page": 25,
  "total": 1372
}
```

---

<a id="get-apiv2galleriestagged"></a>

#### `GET` `/api/v2/galleries/tagged`

**Get Galleries By Tag**

Get galleries with a specific tag.

| | |
|---|---|
| **Operation ID** | `get_galleries_by_tag_api_v2_galleries_tagged_get` |
| **Auth** | Public (optional User Token or API Key for personalization) |
| **Security schemes** | `User Token` or `API Key` |
| **Rate limits** | When `auth=anon`: • 15/1min per IP <br> When `auth=user\|key`: • 30/1min per IP |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `tag_id` | `integer` | **yes** | — | Tag ID to filter by |
| `sort` | `string` enum | no | one of `"date"`, `"popular"`, `"popular-today"`, `"popular-week"`, `"popular-month"`; default: `"date"` | Sort |
| `page` | `integer` | no | min: `1`; default: `1` | Page number |
| `per_page` | `integer` | no | min: `1`; max: `100`; default: `25` | Items per page |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`PaginatedResponse_GalleryListItem_`](#schema-paginatedresponse-gallerylistitem-) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/galleries/tagged?tag_id=1234&sort=date&page=1&per_page=25' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
{
  "result": [
    {
      "id": 2841902,
      "media_id": "2841902",
      "english_title": "Example Gallery Title",
      "japanese_title": "サンプルタイトル",
      "thumbnail": "/galleries/2841902/3.webp",
      "thumbnail_width": 1280,
      "thumbnail_height": 1807,
      "num_pages": 24,
      "num_favorites": 12,
      "tag_ids": [
        1234
      ],
      "blacklisted": false
    }
  ],
  "num_pages": 24,
  "per_page": 25,
  "total": 1372
}
```

---

<a id="get-apiv2galleriespopular"></a>

#### `GET` `/api/v2/galleries/popular`

**Get Popular Galleries**

Get today's popular galleries.

| | |
|---|---|
| **Operation ID** | `get_popular_galleries_api_v2_galleries_popular_get` |
| **Auth** | Public (optional User Token or API Key for personalization) |
| **Security schemes** | `User Token` or `API Key` |
| **Rate limits** | 8/1min per IP |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → array of [`GalleryListItem`](#schema-gallerylistitem) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/galleries/popular' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
[
  {
    "id": 2841902,
    "media_id": "2841902",
    "english_title": "Example Gallery Title",
    "japanese_title": "サンプルタイトル",
    "thumbnail": "/galleries/2841902/3.webp",
    "thumbnail_width": 1280,
    "thumbnail_height": 1807,
    "num_pages": 24,
    "num_favorites": 12,
    "tag_ids": [
      1234
    ],
    "blacklisted": false
  }
]
```

---

<a id="get-apiv2galleriesrandom"></a>

#### `GET` `/api/v2/galleries/random`

**Get Random Gallery**

Get a random gallery ID.

| | |
|---|---|
| **Operation ID** | `get_random_gallery_api_v2_galleries_random_get` |
| **Auth** | Public (optional User Token or API Key for personalization) |
| **Security schemes** | `User Token` or `API Key` |
| **Rate limits** | When `auth=anon`: • 20/1min per IP <br> When `auth=user\|key`: • 30/1min per IP |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → `object` |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/galleries/random' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
{}
```

---

<a id="get-apiv2galleriesgallery-id"></a>

#### `GET` `/api/v2/galleries/{gallery_id}`

**Get Gallery**

Get a single gallery with full details and optional includes.

| | |
|---|---|
| **Operation ID** | `get_gallery_api_v2_galleries__gallery_id__get` |
| **Auth** | Public (optional User Token or API Key for personalization) |
| **Security schemes** | `User Token` or `API Key` |
| **Rate limits** | When `auth=anon`: • 20/1min per IP <br> When `auth=user\|key`: • 45/1min per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `gallery_id` | `integer` | **yes** | — | Gallery Id |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `include` | `string` | no | default: `""` | Comma-separated: comments,related,favorite,suggestions |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`GalleryDetailResponse`](#schema-gallerydetailresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/galleries/2841902?include=string' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
{
  "id": 2841902,
  "media_id": "2841902",
  "title": {
    "english": "Example Gallery Title",
    "japanese": "サンプルタイトル",
    "pretty": "Example Gallery Title"
  },
  "cover": {
    "path": "/galleries/2841902/3.webp",
    "width": 1280,
    "height": 1807
  },
  "thumbnail": {
    "path": "/galleries/2841902/3.webp",
    "width": 1280,
    "height": 1807
  },
  "scanlator": "string",
  "upload_date": 1778000000,
  "tags": [
    {
      "id": 33814,
      "type": "tag",
      "name": "example",
      "slug": "example-slug",
      "url": "https://cdn.example.net/galleries/1451234/3.webp",
      "count": 12,
      "description": "A short human-readable description.",
      "is_community": false,
      "pending_describe_id": "string"
    }
  ],
  "num_pages": 24,
  "num_favorites": 12,
  "pages": [
    {
      "number": 1,
      "path": "/galleries/2841902/3.webp",
      "width": 1280,
      "height": 1807,
      "thumbnail": "/galleries/2841902/3.webp",
      "thumbnail_width": 1280,
      "thumbnail_height": 1807
    }
  ],
  "comments": [
    {
      "id": 4410927,
      "gallery_id": 2841902,
      "poster": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png",
        "is_superuser": false,
        "is_staff": false
      },
      "post_date": 1778000000,
      "body": "Thanks for the upload!"
    }
  ],
  "comment_count": 12,
  "related": [
    {
      "id": 2841902,
      "media_id": "2841902",
      "english_title": "Example Gallery Title",
      "japanese_title": "サンプルタイトル",
      "thumbnail": "/galleries/2841902/3.webp",
      "thumbnail_width": 1280,
      "thumbnail_height": 1807,
      "num_pages": 24,
      "num_favorites": 12,
      "tag_ids": [],
      "blacklisted": false
    }
  ],
  "is_favorited": false,
  "suggestions": {
    "trending": [
      {
        "id": "string",
        "gallery_id": 2841902,
        "tag": null,
        "action": "add",
        "status": "pending",
        "score": 5,
        "voter_count": 12,
        "proposer": null,
        "created_at": "2026-05-14T09:21:07Z",
        "resolved_at": "2026-05-14T09:21:07Z",
        "resolver": null,
        "resolution_note": "Reviewed and approved by staff.",
        "reverted_at": "2026-05-14T09:21:07Z",
        "reverter": null,
        "my_vote": 1,
        "tier": "trending"
      }
    ],
    "active": [
      {
        "id": "string",
        "gallery_id": 2841902,
        "tag": null,
        "action": "add",
        "status": "pending",
        "score": 5,
        "voter_count": 12,
        "proposer": null,
        "created_at": "2026-05-14T09:21:07Z",
        "resolved_at": "2026-05-14T09:21:07Z",
        "resolver": null,
        "resolution_note": "Reviewed and approved by staff.",
        "reverted_at": "2026-05-14T09:21:07Z",
        "reverter": null,
        "my_vote": 1,
        "tier": "trending"
      }
    ],
    "mine": [
      {
        "id": "string",
        "gallery_id": 2841902,
        "tag": null,
        "action": "add",
        "status": "pending",
        "score": 5,
        "voter_count": 12,
        "proposer": null,
        "created_at": "2026-05-14T09:21:07Z",
        "resolved_at": "2026-05-14T09:21:07Z",
        "resolver": null,
        "resolution_note": "Reviewed and approved by staff.",
        "reverted_at": "2026-05-14T09:21:07Z",
        "reverter": null,
        "my_vote": 1,
        "tier": "trending"
      }
    ],
    "counts": {
      "trending": 1,
      "active": 1,
      "declined": 1,
      "hidden": 1
    }
  }
}
```

---

<a id="get-apiv2galleriesgallery-idrelated"></a>

#### `GET` `/api/v2/galleries/{gallery_id}/related`

**Get Related Galleries**

Get galleries similar to the specified gallery.

| | |
|---|---|
| **Operation ID** | `get_related_galleries_api_v2_galleries__gallery_id__related_get` |
| **Auth** | Public (optional User Token or API Key for personalization) |
| **Security schemes** | `User Token` or `API Key` |
| **Rate limits** | When `auth=anon`: • 12/1min per IP <br> When `auth=user\|key`: • 30/1min per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `gallery_id` | `integer` | **yes** | — | Gallery Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`RelatedGalleriesResponse`](#schema-relatedgalleriesresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/galleries/2841902/related' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
{
  "result": [
    {
      "id": 2841902,
      "media_id": "2841902",
      "english_title": "Example Gallery Title",
      "japanese_title": "サンプルタイトル",
      "thumbnail": "/galleries/2841902/3.webp",
      "thumbnail_width": 1280,
      "thumbnail_height": 1807,
      "num_pages": 24,
      "num_favorites": 12,
      "tag_ids": [
        1234
      ],
      "blacklisted": false
    }
  ]
}
```

---

<a id="get-apiv2galleriesgallery-idfavorite"></a>

#### `GET` `/api/v2/galleries/{gallery_id}/favorite`

**Check Favorite**

Check if a gallery is in the user's favorites.

| | |
|---|---|
| **Operation ID** | `check_favorite_api_v2_galleries__gallery_id__favorite_get` |
| **Auth** | User Token or API Key |
| **Security schemes** | `User Token` or `API Key` |
| **Rate limits** | 15/1min per user • 15/1min per API key owner |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `gallery_id` | `integer` | **yes** | — | Gallery Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`FavoriteResponse`](#schema-favoriteresponse) |
| `401` | Unauthorized | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/galleries/2841902/favorite' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
{
  "favorited": false,
  "num_favorites": 12
}
```

---

<a id="post-apiv2galleriesgallery-idfavorite"></a>

#### `POST` `/api/v2/galleries/{gallery_id}/favorite`

**Add To Favorites**

Add a gallery to the current user's favorites.

| | |
|---|---|
| **Operation ID** | `add_to_favorites_api_v2_galleries__gallery_id__favorite_post` |
| **Auth** | User Token or API Key |
| **Security schemes** | `User Token` or `API Key` |
| **Feature Flag** | `allow_favorites` must be enabled |
| **Rate limits** | 15/1min per user • 15/1min per API key owner • 15/1min per IP + user • 15/1min per IP + API key owner |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `gallery_id` | `integer` | **yes** | — | Gallery Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`FavoriteResponse`](#schema-favoriteresponse) |
| `401` | Unauthorized | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/galleries/2841902/favorite' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
{
  "favorited": false,
  "num_favorites": 12
}
```

---

<a id="delete-apiv2galleriesgallery-idfavorite"></a>

#### `DELETE` `/api/v2/galleries/{gallery_id}/favorite`

**Remove From Favorites**

Remove a gallery from the current user's favorites.

| | |
|---|---|
| **Operation ID** | `remove_from_favorites_api_v2_galleries__gallery_id__favorite_delete` |
| **Auth** | User Token or API Key |
| **Security schemes** | `User Token` or `API Key` |
| **Feature Flag** | `allow_favorites` must be enabled |
| **Rate limits** | 15/1min per user • 15/1min per API key owner • 15/1min per IP + user • 15/1min per IP + API key owner |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `gallery_id` | `integer` | **yes** | — | Gallery Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`FavoriteResponse`](#schema-favoriteresponse) |
| `401` | Unauthorized | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X DELETE 'https://nhentai.net/api/v2/galleries/2841902/favorite' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
{
  "favorited": false,
  "num_favorites": 12
}
```

---

<a id="post-apiv2galleriesgallery-idedit"></a>

#### `POST` `/api/v2/galleries/{gallery_id}/edit`

**Submit Gallery Edit**

Retired. Tag changes go through the suggestion flow now.

| | |
|---|---|
| **Operation ID** | `submit_gallery_edit_api_v2_galleries__gallery_id__edit_post` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `gallery_id` | `integer` | **yes** | — | Gallery Id |

**Request body** — `application/json` (required)

Schema: [`SubmitEditRequest`](#schema-submiteditrequest)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `created_tags` | array of [`CreatedTag`](#schema-createdtag) | no | max items: `50`; default: `[]` | Created Tags |
| `added_tags` | array of `integer` | no | max items: `100`; default: `[]` | Added Tags |
| `removed_tags` | array of `integer` | no | max items: `100`; default: `[]` | Removed Tags |

```json
{
  "created_tags": [
    {
      "type": "tag",
      "name": "example"
    }
  ],
  "added_tags": [
    1
  ],
  "removed_tags": [
    1
  ]
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SubmitEditResponse`](#schema-submiteditresponse) |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `401` | Unauthorized | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `409` | Conflict | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/galleries/2841902/edit' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '{"created_tags": [{"type": "tag", "name": "example"}], "added_tags": [1], "removed_tags": [1]}'
```

**Example response** — `200`

```json
{
  "success": true,
  "edit_id": 1842,
  "auto_applied": false
}
```

---

<a id="post-apiv2galleriesgallery-iddownload"></a>

#### `POST` `/api/v2/galleries/{gallery_id}/download`

**Get a download URL for a gallery**

Returns a short-lived URL for the gallery as a zip, cbz, or torrent
file. Fetch `url` before `expires_at` (unix timestamp).

| | |
|---|---|
| **Operation ID** | `issue_download_url_api_v2_galleries__gallery_id__download_post` |
| **Auth** | User Token or API Key |
| **Security schemes** | `User Token` or `API Key` |
| **Feature Flag** | `allow_downloads` must be enabled |
| **Rate limits** | When `format=torrent`: • 5/1min per IP • 10/5min per user • 5/1min per API key owner <br> When `format=zip\|cbz (default)`: • 10/5min per IP • 7/5min per user • 10/5min per API key owner |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `gallery_id` | `integer` | **yes** | — | Gallery Id |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `format` | `string` enum | no | one of `"zip"`, `"cbz"`, `"torrent"`; default: `"zip"` | Format |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`DownloadResponse`](#schema-downloadresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/galleries/2841902/download?format=zip' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
{
  "url": "https://cdn.example.net/galleries/1451234/3.webp",
  "expires_at": 1778000900
}
```

---

### search

Full-text gallery search with filters.

*1 operation.*

<a id="get-apiv2search"></a>

#### `GET` `/api/v2/search`

**Search Galleries**

Search galleries.

Supports:
- Keywords: `word`
- Exact phrases: `"exact phrase"`
- Negation: `-word`, `-"exact phrase"`, `-artist:name`
- Tag filters: `artist:name`, `language:english`, `tag:"big breasts"`
- Numeric filters: `pages:>10`, `favorites:>=100`
- Date filters: `uploaded:<7d`, `uploaded:>1m`

| | |
|---|---|
| **Operation ID** | `search_galleries_api_v2_search_get` |
| **Auth** | Public (optional User Token or API Key for personalization) |
| **Security schemes** | `User Token` or `API Key` |
| **Rate limits** | When `auth=anon`: • 10/1min per IP <br> When `auth=user\|key`: • 20/1min per IP |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `query` | `string` | **yes** | min length: `1` | Search query |
| `sort` | `string` enum | no | one of `"date"`, `"popular"`, `"popular-today"`, `"popular-week"`, `"popular-month"`; default: `"date"` | Sort order |
| `page` | `integer` | no | min: `1`; default: `1` | Page number |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`PaginatedResponse_GalleryListItem_`](#schema-paginatedresponse-gallerylistitem-) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/search?query=artist%3Aexample%20language%3Aenglish&sort=date&page=1' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
{
  "result": [
    {
      "id": 2841902,
      "media_id": "2841902",
      "english_title": "Example Gallery Title",
      "japanese_title": "サンプルタイトル",
      "thumbnail": "/galleries/2841902/3.webp",
      "thumbnail_width": 1280,
      "thumbnail_height": 1807,
      "num_pages": 24,
      "num_favorites": 12,
      "tag_ids": [
        1234
      ],
      "blacklisted": false
    }
  ],
  "num_pages": 24,
  "per_page": 25,
  "total": 1372
}
```

---

### tags

Tag lookup, listing, and search.

*4 operations.*

<a id="get-apiv2tagsids"></a>

#### `GET` `/api/v2/tags/ids`

**Get Tags By Ids**

Look up multiple tags by ID. Max 100 per request.

| | |
|---|---|
| **Operation ID** | `get_tags_by_ids_api_v2_tags_ids_get` |
| **Auth** | Public (no authentication required) |
| **Security schemes** | None declared |
| **Rate limits** | 15/1min per IP |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `ids` | `string` | **yes** | — | Comma-separated tag IDs |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → array of [`TagResponse`](#schema-tagresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/tags/ids?ids=string' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)'
```

**Example response** — `200`

```json
[
  {
    "id": 33814,
    "type": "tag",
    "name": "example",
    "slug": "example-slug",
    "url": "https://cdn.example.net/galleries/1451234/3.webp",
    "count": 12,
    "description": "A short human-readable description.",
    "is_community": false,
    "pending_describe_id": "string"
  }
]
```

---

<a id="post-apiv2tagssearch"></a>

#### `POST` `/api/v2/tags/search`

**Search Tags**

Search tags by name prefix. Omit `type` to search across all tag types.

| | |
|---|---|
| **Operation ID** | `search_tags_api_v2_tags_search_post` |
| **Auth** | Public (no authentication required) |
| **Security schemes** | None declared |
| **Rate limits** | 30/1min per IP |

**Request body** — `application/json` (required)

Schema: [`AutocompleteRequest`](#schema-autocompleterequest)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `type` | `string` *(nullable)* | no | — | Type |
| `query` | `string` *(nullable)* | no | — | Query |
| `limit` | `integer` | no | min: `1.0`; max: `50.0`; default: `10` | Limit |

```json
{
  "type": "tag",
  "query": "artist:example language:english",
  "limit": 10
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → array of [`TagResponse`](#schema-tagresponse) |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/tags/search' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Content-Type: application/json' \
  -d '{"type": "tag", "query": "artist:example language:english", "limit": 10}'
```

**Example response** — `200`

```json
[
  {
    "id": 33814,
    "type": "tag",
    "name": "example",
    "slug": "example-slug",
    "url": "https://cdn.example.net/galleries/1451234/3.webp",
    "count": 12,
    "description": "A short human-readable description.",
    "is_community": false,
    "pending_describe_id": "string"
  }
]
```

---

<a id="get-apiv2tagstag-type"></a>

#### `GET` `/api/v2/tags/{tag_type}`

**Get Tags By Type**

Get tags of a specific type with pagination.

Supports both page-based and cursor-based pagination.

| | |
|---|---|
| **Operation ID** | `get_tags_by_type_api_v2_tags__tag_type__get` |
| **Auth** | Public (no authentication required) |
| **Security schemes** | None declared |
| **Rate limits** | When `auth=anon`: • 15/1min per IP <br> When `auth=user\|key`: • 30/1min per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `tag_type` | `string` | **yes** | — | Tag Type |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `sort` | `string` enum | no | one of `"name"`, `"popular"`; default: `"popular"` | Sort |
| `page` | `integer` | no | min: `1`; default: `1` | Page number |
| `per_page` | `integer` | no | min: `1`; max: `100`; default: `25` | Items per page |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`TagPaginatedResponse`](#schema-tagpaginatedresponse) |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/tags/tag?sort=popular&page=1&per_page=25' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)'
```

**Example response** — `200`

```json
{
  "result": [
    {
      "id": 33814,
      "type": "tag",
      "name": "example",
      "slug": "example-slug",
      "url": "https://cdn.example.net/galleries/1451234/3.webp",
      "count": 12,
      "description": "A short human-readable description.",
      "is_community": false,
      "pending_describe_id": "string"
    }
  ],
  "num_pages": 24,
  "per_page": 120,
  "total": 1372,
  "alphabet": {
    "header": [
      1
    ]
  }
}
```

---

<a id="get-apiv2tagstag-typeslug"></a>

#### `GET` `/api/v2/tags/{tag_type}/{slug}`

**Get Tag By Slug**

Get a specific tag by type and slug.

| | |
|---|---|
| **Operation ID** | `get_tag_by_slug_api_v2_tags__tag_type___slug__get` |
| **Auth** | Public (no authentication required) |
| **Security schemes** | None declared |
| **Rate limits** | When `auth=anon`: • 15/1min per IP <br> When `auth=user\|key`: • 30/1min per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `tag_type` | `string` | **yes** | — | Tag Type |
| `slug` | `string` | **yes** | — | Slug |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`TagResponse`](#schema-tagresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/tags/tag/example-slug' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)'
```

**Example response** — `200`

```json
{
  "id": 33814,
  "type": "tag",
  "name": "example",
  "slug": "example-slug",
  "url": "https://cdn.example.net/galleries/1451234/3.webp",
  "count": 12,
  "description": "A short human-readable description.",
  "is_community": false,
  "pending_describe_id": "string"
}
```

---

### comments

Gallery comments.

*5 operations.*

<a id="get-apiv2galleriesgallery-idcomments"></a>

#### `GET` `/api/v2/galleries/{gallery_id}/comments`

**Get Gallery Comments**

Paginated list of visible comments on a gallery, newest first.

| | |
|---|---|
| **Operation ID** | `get_gallery_comments_api_v2_galleries__gallery_id__comments_get` |
| **Auth** | Public (optional User Token or API Key for personalization) |
| **Security schemes** | `User Token` or `API Key` |
| **Rate limits** | When `auth=anon`: • 30/1min per IP <br> When `auth=user\|key`: • 60/1min per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `gallery_id` | `integer` | **yes** | — | Gallery Id |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `page` | `integer` | no | min: `1`; max: `2000`; default: `1` | Page |
| `per_page` | `integer` | no | min: `1`; max: `50`; default: `50` | Per Page |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`PaginatedResponse_CommentResponse_`](#schema-paginatedresponse-commentresponse-) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/galleries/2841902/comments?page=1&per_page=50' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
{
  "result": [
    {
      "id": 4410927,
      "gallery_id": 2841902,
      "poster": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png",
        "is_superuser": false,
        "is_staff": false
      },
      "post_date": 1778000000,
      "body": "Thanks for the upload!"
    }
  ],
  "num_pages": 24,
  "per_page": 25,
  "total": 1372
}
```

---

<a id="post-apiv2galleriesgallery-idcomments"></a>

#### `POST` `/api/v2/galleries/{gallery_id}/comments`

**Create Comment**

Create a new comment on a gallery.

| | |
|---|---|
| **Operation ID** | `create_comment_api_v2_galleries__gallery_id__comments_post` |
| **Auth** | User Token required |
| **Security schemes** | `User Token` |
| **Feature Flag** | `allow_comments` must be enabled |
| **Protection** | Proof of Work required (`GET /api/v2/pow?action=comment`) <br> CAPTCHA required (`GET /api/v2/captcha` for provider info) |
| **Rate limits** | 5/15min per user • 5/15min per IP + user • 10/15min per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `gallery_id` | `integer` | **yes** | — | Gallery Id |

**Request body** — `application/json` (required)

Schema: [`Body_create_comment_api_v2_galleries__gallery_id__comments_post`](#schema-body-create-comment-api-v2-galleries-gallery-id-comments-post)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `body` | `string` | **yes** | min length: `10`; max length: `1000` | Comment text |
| `captcha_response` | `string` *(nullable)* | no | — | CAPTCHA response token |
| `pow_challenge` | `string` | **yes** | — | PoW challenge from GET /api/v2/pow. Empty string is fine when the action's difficulty is 0. |
| `pow_nonce` | `string` | **yes** | — | Nonce that solves the PoW challenge. Empty string is fine when the action's difficulty is 0. |

```json
{
  "body": "Thanks for the upload!",
  "captcha_response": "03AGdBq26k...captcha-token",
  "pow_challenge": "0f3a9c7e21b845d6",
  "pow_nonce": "000000000001a2f7"
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`CommentResponse`](#schema-commentresponse) |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `401` | Unauthorized | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `403` | Forbidden | `application/json` → [`CaptchaErrorResponse`](#schema-captchaerrorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/galleries/2841902/comments' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '{"body": "Thanks for the upload!", "captcha_response": "03AGdBq26k...captcha-token", "pow_challenge": "0f3a9c7e21b845d6", "pow_nonce": "000000000001a2f7"}'
```

**Example response** — `200`

```json
{
  "id": 4410927,
  "gallery_id": 2841902,
  "poster": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png",
    "is_superuser": false,
    "is_staff": false
  },
  "post_date": 1778000000,
  "body": "Thanks for the upload!"
}
```

---

<a id="get-apiv2galleriesgallery-idcommentscount"></a>

#### `GET` `/api/v2/galleries/{gallery_id}/comments/count`

**Get Gallery Comment Count**

Get the visible comment count for a gallery.

| | |
|---|---|
| **Operation ID** | `get_gallery_comment_count_api_v2_galleries__gallery_id__comments_count_get` |
| **Auth** | Public (no authentication required) |
| **Security schemes** | None declared |
| **Rate limits** | When `auth=anon`: • 12/1min per IP <br> When `auth=user\|key`: • 20/1min per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `gallery_id` | `integer` | **yes** | — | Gallery Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → `integer` |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/galleries/2841902/comments/count' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)'
```

**Example response** — `200`

```json
1
```

---

<a id="delete-apiv2commentscomment-id"></a>

#### `DELETE` `/api/v2/comments/{comment_id}`

**Delete Comment**

Delete a comment.

Only the comment owner or staff can delete comments.

| | |
|---|---|
| **Operation ID** | `delete_comment_api_v2_comments__comment_id__delete` |
| **Auth** | User Token required |
| **Security schemes** | `User Token` |
| **Feature Flag** | `allow_comments` must be enabled |
| **Rate limits** | 5/15min per user • 5/15min per IP + user |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `comment_id` | `integer` | **yes** | — | Comment Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SuccessResponse`](#schema-successresponse) |
| `401` | Unauthorized | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X DELETE 'https://nhentai.net/api/v2/comments/4410927' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "success": true,
  "message": "Thanks for the upload!"
}
```

---

<a id="post-apiv2commentscomment-idflag"></a>

#### `POST` `/api/v2/comments/{comment_id}/flag`

**Flag Comment**

Flag a comment for review.

| | |
|---|---|
| **Operation ID** | `flag_comment_api_v2_comments__comment_id__flag_post` |
| **Auth** | User Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 10/15min per user • 10/15min per IP + user • 15/15min per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `comment_id` | `integer` | **yes** | — | Comment Id |

**Request body** — `application/json` (required)

Schema: [`FlagCommentRequest`](#schema-flagcommentrequest)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `reason` | `string` | **yes** | min length: `1`; max length: `500` | Reason |

```json
{
  "reason": "Duplicate of an existing entry"
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SuccessResponse`](#schema-successresponse) |
| `401` | Unauthorized | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/comments/4410927/flag' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '{"reason": "Duplicate of an existing entry"}'
```

**Example response** — `200`

```json
{
  "success": true,
  "message": "Thanks for the upload!"
}
```

---

### favorites

Favorite gallery management.

*2 operations.*

<a id="get-apiv2favorites"></a>

#### `GET` `/api/v2/favorites`

**Get Favorites**

Get the authenticated user's favorite galleries.

| | |
|---|---|
| **Operation ID** | `get_favorites_api_v2_favorites_get` |
| **Auth** | User Token or API Key |
| **Security schemes** | `User Token` or `API Key` |
| **Rate limits** | 15/1min per user • 15/1min per API key owner |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `q` | `string` *(nullable)* | no | — | Search within favorites |
| `page` | `integer` | no | min: `1`; default: `1` | Page |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`PaginatedResponse_GalleryListItem_`](#schema-paginatedresponse-gallerylistitem-) |
| `401` | Unauthorized | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/favorites?page=1' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
{
  "result": [
    {
      "id": 2841902,
      "media_id": "2841902",
      "english_title": "Example Gallery Title",
      "japanese_title": "サンプルタイトル",
      "thumbnail": "/galleries/2841902/3.webp",
      "thumbnail_width": 1280,
      "thumbnail_height": 1807,
      "num_pages": 24,
      "num_favorites": 12,
      "tag_ids": [
        1234
      ],
      "blacklisted": false
    }
  ],
  "num_pages": 24,
  "per_page": 25,
  "total": 1372
}
```

---

<a id="get-apiv2favoritesrandom"></a>

#### `GET` `/api/v2/favorites/random`

**Get Random Favorite**

Get a random gallery ID from the authenticated user's favorites.

| | |
|---|---|
| **Operation ID** | `get_random_favorite_api_v2_favorites_random_get` |
| **Auth** | User Token or API Key |
| **Security schemes** | `User Token` or `API Key` |
| **Rate limits** | 15/1min per user • 15/1min per API key owner |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → `object` |
| `401` | Unauthorized | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/favorites/random' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
{}
```

---

### blacklist

Tag blacklist management.

*3 operations.*

<a id="get-apiv2blacklist"></a>

#### `GET` `/api/v2/blacklist`

**Get Blacklist**

Get the authenticated user's blacklisted tags.

| | |
|---|---|
| **Operation ID** | `get_blacklist_api_v2_blacklist_get` |
| **Auth** | User Token or API Key |
| **Security schemes** | `User Token` or `API Key` |
| **Rate limits** | 15/1min per user • 15/1min per API key owner |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`BlacklistListResponse`](#schema-blacklistlistresponse) |
| `401` | Unauthorized | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/blacklist' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
{
  "tags": [
    {
      "id": 33814,
      "type": "tag",
      "name": "example",
      "slug": "example-slug",
      "count": 12
    }
  ],
  "count": 12
}
```

---

<a id="post-apiv2blacklist"></a>

#### `POST` `/api/v2/blacklist`

**Update Blacklist**

Add or remove tags from the authenticated user's blacklist.

| | |
|---|---|
| **Operation ID** | `update_blacklist_api_v2_blacklist_post` |
| **Auth** | User Token or API Key |
| **Security schemes** | `User Token` or `API Key` |
| **Rate limits** | 20/15min per user • 20/15min per API key owner |

**Request body** — `application/json` (required)

Schema: [`BlacklistUpdateRequest`](#schema-blacklistupdaterequest)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `added` | array of `integer` | no | default: `[]` | Added |
| `removed` | array of `integer` | no | default: `[]` | Removed |

```json
{
  "added": [
    1
  ],
  "removed": [
    1
  ]
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`BlacklistResponse`](#schema-blacklistresponse) |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `401` | Unauthorized | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/blacklist' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9' \
  -H 'Content-Type: application/json' \
  -d '{"added": [1], "removed": [1]}'
```

**Example response** — `200`

```json
{
  "success": true,
  "count": 12
}
```

---

<a id="get-apiv2blacklistids"></a>

#### `GET` `/api/v2/blacklist/ids`

**Get Blacklist Ids**

Get just the tag IDs for the authenticated user's blacklist.

| | |
|---|---|
| **Operation ID** | `get_blacklist_ids_api_v2_blacklist_ids_get` |
| **Auth** | User Token or API Key |
| **Security schemes** | `User Token` or `API Key` |
| **Rate limits** | 45/1min per user |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → array of `integer` |
| `401` | Unauthorized | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/blacklist/ids' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
[
  1
]
```

---

### users

Public user profiles.

*1 operation.*

<a id="get-apiv2usersuser-idslug"></a>

#### `GET` `/api/v2/users/{user_id}/{slug}`

**Get User Profile**

Get a user's public profile.

Requires both the user ID and correct username slug.

| | |
|---|---|
| **Operation ID** | `get_user_profile_api_v2_users__user_id___slug__get` |
| **Auth** | Public (optional User Token or API Key for personalization) |
| **Security schemes** | `User Token` or `API Key` |
| **Rate limits** | When `auth=anon`: • 5/1min per IP <br> When `auth=user\|key`: • 10/1min per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `user_id` | `integer` | **yes** | — | User Id |
| `slug` | `string` | **yes** | — | Slug |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`UserProfileResponse`](#schema-userprofileresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/users/90210/example-slug' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
{
  "id": 90210,
  "username": "example_user",
  "slug": "example-slug",
  "avatar_url": "https://cdn.example.net/avatars/90210.png",
  "is_superuser": false,
  "is_staff": false,
  "date_joined": 1778000000,
  "about": "Long-time reader. Mostly here for the artbooks.",
  "favorite_tags": "english",
  "recent_favorites": [
    {
      "id": 2841902,
      "media_id": "2841902",
      "thumbnail": "/galleries/2841902/3.webp",
      "thumbnail_width": 1280,
      "thumbnail_height": 1807,
      "english_title": "Example Gallery Title",
      "japanese_title": "サンプルタイトル",
      "num_pages": 24,
      "tag_ids": [
        1234
      ]
    }
  ],
  "recent_comments": [
    {
      "id": 4410927,
      "gallery_id": 2841902,
      "body": "Thanks for the upload!",
      "post_date": 1778000000,
      "gallery_title": "example"
    }
  ]
}
```

---

### user

**First-party and internal only**, bar `GET /api/v2/user`. These endpoints are documented for API completeness and should NOT be used by third-party clients. They are intended only for nhentai's own services and will be enforced. Third-party applications should authenticate using API keys via `Authorization: Key YOUR_API_KEY`.

*7 operations.*

<a id="get-apiv2user"></a>

#### `GET` `/api/v2/user`

**Get Me**

Get your profile info. Email is hidden for API key auth.

| | |
|---|---|
| **Operation ID** | `get_me_api_v2_user_get` |
| **Auth** | User Token or API Key |
| **Security schemes** | `User Token` or `API Key` |
| **Rate limits** | 45/1min per user • 45/1min per API key owner |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`UserMeResponse`](#schema-usermeresponse) |
| `401` | Unauthorized | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/user' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
{
  "id": 90210,
  "username": "example_user",
  "slug": "example-slug",
  "avatar_url": "https://cdn.example.net/avatars/90210.png",
  "theme": "black",
  "is_staff": false,
  "is_superuser": false,
  "about": "Long-time reader. Mostly here for the artbooks.",
  "favorite_tags": "english",
  "email": "user@example.com"
}
```

---

<a id="put-apiv2user"></a>

#### `PUT` `/api/v2/user`

**Update Profile**

Update your profile.

| | |
|---|---|
| **Operation ID** | `update_profile_api_v2_user_put` |
| **Auth** | User Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/15min per user • 30/15min per IP + user |

**Request body** — `application/json` (required)

Schema: [`UpdateProfileRequest`](#schema-updateprofilerequest)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `username` | `string` *(nullable)* | no | — | Username |
| `email` | `string` *(nullable)* | no | — | Email |
| `about` | `string` *(nullable)* | no | — | About |
| `favorite_tags` | `string` *(nullable)* | no | — | Favorite Tags |
| `theme` | `string` *(nullable)* | no | — | Theme |
| `current_password` | `string` *(nullable)* | no | — | Current Password |
| `new_password` | `string` *(nullable)* | no | — | New Password |
| `default_avatar` | `string` enum *(nullable)* | no | one of `"default"`, `"classic"` | Default Avatar |

```json
{
  "username": "example_user",
  "email": "user@example.com",
  "about": "Long-time reader. Mostly here for the artbooks.",
  "favorite_tags": "english",
  "theme": "string",
  "current_password": "S3cur3-Passphrase!",
  "new_password": "S3cur3-Passphrase!",
  "default_avatar": "default"
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`UpdateProfileResponse`](#schema-updateprofileresponse) |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `401` | Unauthorized | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `409` | Conflict | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X PUT 'https://nhentai.net/api/v2/user' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '{"username": "example_user", "email": "user@example.com", "about": "Long-time reader. Mostly here for the artbooks.", "favorite_tags": "english", "theme": "string", "current_password": "S3cur3-Passphrase!", "new_password": "S3cur3-Passphrase!", "default_avatar": "default"}'
```

**Example response** — `200`

```json
{
  "success": true,
  "username": "example_user",
  "email": "user@example.com",
  "avatar_url": "https://cdn.example.net/avatars/90210.png",
  "about": "Long-time reader. Mostly here for the artbooks.",
  "favorite_tags": "english",
  "theme": "black"
}
```

---

<a id="delete-apiv2user"></a>

#### `DELETE` `/api/v2/user`

**Delete Account**

Delete your account. Requires password and username confirmation.

| | |
|---|---|
| **Operation ID** | `delete_account_api_v2_user_delete` |
| **Auth** | User Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 3/1h per user • 3/1h per IP + user |

**Request body** — `application/json` (required)

Schema: [`DeleteProfileRequest`](#schema-deleteprofilerequest)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `password` | `string` | **yes** | — | Password |
| `confirmation` | `string` | **yes** | — | Confirmation |

```json
{
  "password": "S3cur3-Passphrase!",
  "confirmation": "string"
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`DeleteProfileResponse`](#schema-deleteprofileresponse) |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `401` | Unauthorized | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X DELETE 'https://nhentai.net/api/v2/user' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '{"password": "S3cur3-Passphrase!", "confirmation": "string"}'
```

**Example response** — `200`

```json
{
  "success": true,
  "message": "Thanks for the upload!"
}
```

---

<a id="post-apiv2useravatar"></a>

#### `POST` `/api/v2/user/avatar`

**Upload Avatar**

Upload a new avatar image.

Accepts JPEG, PNG, GIF, or WebP up to 10 MB. The image is converted to
PNG and resized to fit within 200x200 pixels. Returns the new avatar URL.

| | |
|---|---|
| **Operation ID** | `upload_avatar_api_v2_user_avatar_post` |
| **Auth** | User Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 5/1min per user |

**Request body** — `multipart/form-data` (required)

Schema: [`Body_upload_avatar_api_v2_user_avatar_post`](#schema-body-upload-avatar-api-v2-user-avatar-post)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `avatar` | `string` (`binary`) | **yes** | format: `binary` | Avatar |

```http
Content-Type: multipart/form-data; boundary=----boundary

------boundary
Content-Disposition: form-data; name="avatar"; filename="avatar.png"
Content-Type: image/png

<binary file data>
------boundary--
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → `object` |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `401` | Unauthorized | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `413` | Request Entity Too Large | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `502` | Bad Gateway | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/user/avatar' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -F 'avatar=@avatar.png'
```

**Example response** — `200`

```json
{}
```

---

<a id="get-apiv2userkeys"></a>

#### `GET` `/api/v2/user/keys`

**List Api Keys**

List your API keys.

| | |
|---|---|
| **Operation ID** | `list_api_keys_api_v2_user_keys_get` |
| **Auth** | User Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/1min per user |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → array of [`ApiKeyListItem`](#schema-apikeylistitem) |
| `401` | Unauthorized | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/user/keys' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
[
  {
    "id": "string",
    "key_prefix": "string",
    "name": "example",
    "created_at": 1778000000,
    "last_used_at": 1778000000
  }
]
```

---

<a id="post-apiv2userkeys"></a>

#### `POST` `/api/v2/user/keys`

**Create Api Key**

Create a new API key. The raw key is only shown once.

| | |
|---|---|
| **Operation ID** | `create_api_key_api_v2_user_keys_post` |
| **Auth** | User Token required |
| **Security schemes** | `User Token` |
| **Feature Flag** | `allow_api_keys` must be enabled |
| **Protection** | Proof of Work required (`GET /api/v2/pow?action=api_key`) <br> CAPTCHA required (`GET /api/v2/captcha` for provider info) |
| **Rate limits** | 5/1h per user • 5/1h per IP + user |

**Request body** — `application/json` (required)

Schema: [`Body_create_api_key_api_v2_user_keys_post`](#schema-body-create-api-key-api-v2-user-keys-post)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | `string` | **yes** | min length: `1`; max length: `255` | Name |
| `purpose` | `string` | no | default: `""` | Purpose |
| `pow_challenge` | `string` | **yes** | — | PoW challenge from GET /api/v2/pow. Empty string is fine when the action's difficulty is 0. |
| `pow_nonce` | `string` | **yes** | — | Nonce that solves the PoW challenge. Empty string is fine when the action's difficulty is 0. |
| `captcha_response` | `string` | **yes** | — | CAPTCHA response token from the widget |

```json
{
  "name": "example",
  "purpose": "string",
  "pow_challenge": "0f3a9c7e21b845d6",
  "pow_nonce": "000000000001a2f7",
  "captcha_response": "03AGdBq26k...captcha-token"
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`ApiKeyCreateResponse`](#schema-apikeycreateresponse) |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `401` | Unauthorized | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/user/keys' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '{"name": "example", "purpose": "string", "pow_challenge": "0f3a9c7e21b845d6", "pow_nonce": "000000000001a2f7", "captcha_response": "03AGdBq26k...captcha-token"}'
```

**Example response** — `200`

```json
{
  "id": "string",
  "key": "nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9",
  "name": "example"
}
```

---

<a id="delete-apiv2userkeyskey-id"></a>

#### `DELETE` `/api/v2/user/keys/{key_id}`

**Revoke Api Key**

Revoke an API key.

| | |
|---|---|
| **Operation ID** | `revoke_api_key_api_v2_user_keys__key_id__delete` |
| **Auth** | User Token required |
| **Security schemes** | `User Token` |
| **Feature Flag** | `allow_api_keys` must be enabled |
| **Rate limits** | 10/1h per user • 10/1h per IP + user |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `key_id` | `string` | **yes** | — | Key Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SuccessResponse`](#schema-successresponse) |
| `401` | Unauthorized | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X DELETE 'https://nhentai.net/api/v2/user/keys/string' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "success": true,
  "message": "Thanks for the upload!"
}
```

---

### auth

**First-party and internal only.** These endpoints are documented for API completeness and should NOT be used by third-party clients. They are intended only for nhentai's own services and will be enforced. Third-party applications should authenticate using API keys via `Authorization: Key YOUR_API_KEY`.

*9 operations.*

<a id="post-apiv2authlogin"></a>

#### `POST` `/api/v2/auth/login`

**Login**

Authenticate with username/email and password.

Returns access token and refresh token.

| | |
|---|---|
| **Operation ID** | `login_api_v2_auth_login_post` |
| **Auth** | Public (no authentication required) |
| **Security schemes** | None declared |
| **Protection** | Proof of Work required (`GET /api/v2/pow?action=login`) <br> CAPTCHA required (`GET /api/v2/captcha` for provider info) |
| **Rate limits** | 10/15min per IP |

**Request body** — `application/json` (required)

Schema: [`Body_login_api_v2_auth_login_post`](#schema-body-login-api-v2-auth-login-post)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `username` | `string` | **yes** | — | Username or email |
| `password` | `string` | **yes** | — | Password |
| `pow_challenge` | `string` | **yes** | — | PoW challenge from GET /api/v2/pow. Empty string is fine when the action's difficulty is 0. |
| `pow_nonce` | `string` | **yes** | — | Nonce that solves the PoW challenge. Empty string is fine when the action's difficulty is 0. |
| `captcha_response` | `string` | **yes** | — | CAPTCHA response token from the widget |

```json
{
  "username": "example_user",
  "password": "S3cur3-Passphrase!",
  "pow_challenge": "0f3a9c7e21b845d6",
  "pow_nonce": "000000000001a2f7",
  "captcha_response": "03AGdBq26k...captcha-token"
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`TokenResponse`](#schema-tokenresponse) |
| `401` | Unauthorized | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/auth/login' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Content-Type: application/json' \
  -d '{"username": "example_user", "password": "S3cur3-Passphrase!", "pow_challenge": "0f3a9c7e21b845d6", "pow_nonce": "000000000001a2f7", "captcha_response": "03AGdBq26k...captcha-token"}'
```

**Example response** — `200`

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0NDIx",
  "refresh_token": "rt_9f2c4b1ae7d34c8fb0a1e5d6c7b8a9f0",
  "user": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png",
    "theme": "black",
    "is_staff": false,
    "is_superuser": false
  }
}
```

---

<a id="post-apiv2authregister"></a>

#### `POST` `/api/v2/auth/register`

**Register**

Create a new account.

Returns access token and refresh token.

| | |
|---|---|
| **Operation ID** | `register_api_v2_auth_register_post` |
| **Auth** | Public (no authentication required) |
| **Security schemes** | None declared |
| **Feature Flag** | `allow_register` must be enabled |
| **Protection** | Proof of Work required (`GET /api/v2/pow?action=register`) <br> CAPTCHA required (`GET /api/v2/captcha` for provider info) |
| **Rate limits** | 3/1h per IP |

**Request body** — `application/json` (required)

Schema: [`Body_register_api_v2_auth_register_post`](#schema-body-register-api-v2-auth-register-post)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `username` | `string` | **yes** | min length: `3`; max length: `30` | Username |
| `email` | `string` | **yes** | — | Email |
| `password` | `string` | **yes** | min length: `8` | Password |
| `pow_challenge` | `string` | **yes** | — | PoW challenge from GET /api/v2/pow. Empty string is fine when the action's difficulty is 0. |
| `pow_nonce` | `string` | **yes** | — | Nonce that solves the PoW challenge. Empty string is fine when the action's difficulty is 0. |
| `captcha_response` | `string` | **yes** | — | CAPTCHA response token from the widget |

```json
{
  "username": "example_user",
  "email": "user@example.com",
  "password": "S3cur3-Passphrase!",
  "pow_challenge": "0f3a9c7e21b845d6",
  "pow_nonce": "000000000001a2f7",
  "captcha_response": "03AGdBq26k...captcha-token"
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`TokenResponse`](#schema-tokenresponse) |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `409` | Conflict | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/auth/register' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Content-Type: application/json' \
  -d '{"username": "example_user", "email": "user@example.com", "password": "S3cur3-Passphrase!", "pow_challenge": "0f3a9c7e21b845d6", "pow_nonce": "000000000001a2f7", "captcha_response": "03AGdBq26k...captcha-token"}'
```

**Example response** — `200`

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0NDIx",
  "refresh_token": "rt_9f2c4b1ae7d34c8fb0a1e5d6c7b8a9f0",
  "user": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png",
    "theme": "black",
    "is_staff": false,
    "is_superuser": false
  }
}
```

---

<a id="post-apiv2authrefresh"></a>

#### `POST` `/api/v2/auth/refresh`

**Refresh**

Exchange a refresh token for new access + refresh tokens.

The old refresh token is revoked (token rotation).

| | |
|---|---|
| **Operation ID** | `refresh_api_v2_auth_refresh_post` |
| **Auth** | Public (no authentication required) |
| **Security schemes** | None declared |
| **Rate limits** | 15/15min per IP |

**Request body** — `application/json` (required)

Schema: [`Body_refresh_api_v2_auth_refresh_post`](#schema-body-refresh-api-v2-auth-refresh-post)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `refresh_token` | `string` | **yes** | — | Refresh token to exchange |

```json
{
  "refresh_token": "rt_9f2c4b1ae7d34c8fb0a1e5d6c7b8a9f0"
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`RefreshResponse`](#schema-refreshresponse) |
| `401` | Unauthorized | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/auth/refresh' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Content-Type: application/json' \
  -d '{"refresh_token": "rt_9f2c4b1ae7d34c8fb0a1e5d6c7b8a9f0"}'
```

**Example response** — `200`

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0NDIx",
  "refresh_token": "rt_9f2c4b1ae7d34c8fb0a1e5d6c7b8a9f0",
  "user": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png",
    "theme": "black",
    "is_staff": false,
    "is_superuser": false
  }
}
```

---

<a id="post-apiv2authlogout"></a>

#### `POST` `/api/v2/auth/logout`

**Logout**

Revoke the refresh token.

| | |
|---|---|
| **Operation ID** | `logout_api_v2_auth_logout_post` |
| **Auth** | User Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 10/15min per user • 10/15min per IP + user |

**Request body** — `application/json` (required)

Schema: [`Body_logout_api_v2_auth_logout_post`](#schema-body-logout-api-v2-auth-logout-post)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `refresh_token` | `string` | **yes** | — | Refresh token to revoke |

```json
{
  "refresh_token": "rt_9f2c4b1ae7d34c8fb0a1e5d6c7b8a9f0"
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SuccessResponse`](#schema-successresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/auth/logout' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '{"refresh_token": "rt_9f2c4b1ae7d34c8fb0a1e5d6c7b8a9f0"}'
```

**Example response** — `200`

```json
{
  "success": true,
  "message": "Thanks for the upload!"
}
```

---

<a id="post-apiv2authlogoutall"></a>

#### `POST` `/api/v2/auth/logout/all`

**Logout All**

Revoke all sessions for the current user (log out everywhere).

| | |
|---|---|
| **Operation ID** | `logout_all_api_v2_auth_logout_all_post` |
| **Auth** | User Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 5/1h per user • 5/1h per IP + user |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SuccessResponse`](#schema-successresponse) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/auth/logout/all' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "success": true,
  "message": "Thanks for the upload!"
}
```

---

<a id="get-apiv2authsessions"></a>

#### `GET` `/api/v2/auth/sessions`

**Get Sessions**

List all active sessions for the current user.

| | |
|---|---|
| **Operation ID** | `get_sessions_api_v2_auth_sessions_get` |
| **Auth** | User Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/1min per user |

**Header parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `x-refresh-token` | `string` *(nullable)* | no | — | X-Refresh-Token |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → array of [`SessionListItem`](#schema-sessionlistitem) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/auth/sessions' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'x-refresh-token: string'
```

**Example response** — `200`

```json
[
  {
    "id": "string",
    "created_at": 1778000000,
    "expires_at": 1778000900,
    "ip_address": "203.0.113.42",
    "user_agent": "ExampleApp/1.2.0 (https://example.com)",
    "current": false
  }
]
```

---

<a id="delete-apiv2authsessionssession-id"></a>

#### `DELETE` `/api/v2/auth/sessions/{session_id}`

**Revoke Session**

Revoke a specific session by ID.

| | |
|---|---|
| **Operation ID** | `revoke_session_api_v2_auth_sessions__session_id__delete` |
| **Auth** | User Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 10/1min per user |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `session_id` | `string` | **yes** | — | Session Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SuccessResponse`](#schema-successresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X DELETE 'https://nhentai.net/api/v2/auth/sessions/string' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "success": true,
  "message": "Thanks for the upload!"
}
```

---

<a id="post-apiv2authreset"></a>

#### `POST` `/api/v2/auth/reset`

**Request Password Reset**

Request a password reset.

Sends a reset link to the user's email if the account exists.

| | |
|---|---|
| **Operation ID** | `request_password_reset_api_v2_auth_reset_post` |
| **Auth** | Public (no authentication required) |
| **Security schemes** | None declared |
| **Feature Flag** | `allow_password_reset` must be enabled |
| **Protection** | Proof of Work required (`GET /api/v2/pow?action=reset`) <br> CAPTCHA required (`GET /api/v2/captcha` for provider info) |
| **Rate limits** | 3/15min per IP |

**Request body** — `application/json` (required)

Schema: [`Body_request_password_reset_api_v2_auth_reset_post`](#schema-body-request-password-reset-api-v2-auth-reset-post)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `username_or_email` | `string` | **yes** | — | Username or email address |
| `pow_challenge` | `string` | **yes** | — | PoW challenge from GET /api/v2/pow. Empty string is fine when the action's difficulty is 0. |
| `pow_nonce` | `string` | **yes** | — | Nonce that solves the PoW challenge. Empty string is fine when the action's difficulty is 0. |
| `captcha_response` | `string` | **yes** | — | CAPTCHA response token from the widget |

```json
{
  "username_or_email": "user@example.com",
  "pow_challenge": "0f3a9c7e21b845d6",
  "pow_nonce": "000000000001a2f7",
  "captcha_response": "03AGdBq26k...captcha-token"
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SuccessResponse`](#schema-successresponse) |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/auth/reset' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Content-Type: application/json' \
  -d '{"username_or_email": "user@example.com", "pow_challenge": "0f3a9c7e21b845d6", "pow_nonce": "000000000001a2f7", "captcha_response": "03AGdBq26k...captcha-token"}'
```

**Example response** — `200`

```json
{
  "success": true,
  "message": "Thanks for the upload!"
}
```

---

<a id="post-apiv2authresetconfirm"></a>

#### `POST` `/api/v2/auth/reset/confirm`

**Confirm Password Reset**

Confirm a password reset with the token from the reset email.

| | |
|---|---|
| **Operation ID** | `confirm_password_reset_api_v2_auth_reset_confirm_post` |
| **Auth** | Public (no authentication required) |
| **Security schemes** | None declared |
| **Feature Flag** | `allow_password_reset` must be enabled |
| **Protection** | Proof of Work required (`GET /api/v2/pow?action=reset`) <br> CAPTCHA required (`GET /api/v2/captcha` for provider info) |
| **Rate limits** | 5/15min per IP |

**Request body** — `application/json` (required)

Schema: [`Body_confirm_password_reset_api_v2_auth_reset_confirm_post`](#schema-body-confirm-password-reset-api-v2-auth-reset-confirm-post)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `token` | `string` | **yes** | — | Reset token from the email link |
| `password` | `string` | **yes** | min length: `8` | New password |
| `pow_challenge` | `string` | **yes** | — | PoW challenge from GET /api/v2/pow. Empty string is fine when the action's difficulty is 0. |
| `pow_nonce` | `string` | **yes** | — | Nonce that solves the PoW challenge. Empty string is fine when the action's difficulty is 0. |
| `captcha_response` | `string` | **yes** | — | CAPTCHA response token from the widget |

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0NDIx",
  "password": "S3cur3-Passphrase!",
  "pow_challenge": "0f3a9c7e21b845d6",
  "pow_nonce": "000000000001a2f7",
  "captcha_response": "03AGdBq26k...captcha-token"
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SuccessResponse`](#schema-successresponse) |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/auth/reset/confirm' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Content-Type: application/json' \
  -d '{"token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0NDIx", "password": "S3cur3-Passphrase!", "pow_challenge": "0f3a9c7e21b845d6", "pow_nonce": "000000000001a2f7", "captcha_response": "03AGdBq26k...captcha-token"}'
```

**Example response** — `200`

```json
{
  "success": true,
  "message": "Thanks for the upload!"
}
```

---

### GTS

Gallery tag suggestions. Users propose adding/removing a tag on a gallery and vote on others' suggestions; staff accept or reject.

*11 operations.*

<a id="get-apiv2galleriesgallery-idsuggestions"></a>

#### `GET` `/api/v2/galleries/{gallery_id}/suggestions`

**List Gallery Suggestions**

List current tag-change proposals on a gallery.

| | |
|---|---|
| **Operation ID** | `list_gallery_suggestions_api_v2_galleries__gallery_id__suggestions_get` |
| **Auth** | Public (optional User Token or API Key for personalization) |
| **Security schemes** | `User Token` or `API Key` |
| **Feature Flag** | `allow_gts` must be enabled |
| **Rate limits** | 60/1min per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `gallery_id` | `integer` | **yes** | — | Gallery Id |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `tier` | `string` | no | pattern: `^(all\|trending\|active\|declined\|hidden\|mine\|history)$`; default: `"all"` | Tier |
| `limit` | `integer` | no | min: `1`; max: `100`; default: `20` | Limit |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SuggestionListResponse`](#schema-suggestionlistresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/galleries/2841902/suggestions?tier=all&limit=20' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
{
  "result": [
    {
      "id": "string",
      "gallery_id": 2841902,
      "tag": {
        "id": 1842,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "description": "A short human-readable description."
      },
      "action": "add",
      "status": "pending",
      "score": 5,
      "voter_count": 12,
      "proposer": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "created_at": "2026-05-14T09:21:07Z",
      "resolved_at": "2026-05-14T09:21:07Z",
      "resolver": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "resolution_note": "Reviewed and approved by staff.",
      "reverted_at": "2026-05-14T09:21:07Z",
      "reverter": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "my_vote": 1,
      "tier": "trending"
    }
  ],
  "has_more": false,
  "num_pages": 24,
  "total": 1372
}
```

---

<a id="post-apiv2galleriesgallery-idsuggestions"></a>

#### `POST` `/api/v2/galleries/{gallery_id}/suggestions`

**Create Suggestion**

Propose adding or removing a tag on a gallery.

If a matching proposal already exists, your call adds your vote to it
instead of creating a duplicate.

| | |
|---|---|
| **Operation ID** | `create_suggestion_api_v2_galleries__gallery_id__suggestions_post` |
| **Auth** | User Token required |
| **Security schemes** | `User Token` |
| **Feature Flag** | `allow_gts` must be enabled |
| **Protection** | Proof of Work required (`GET /api/v2/pow?action=gts_create`) <br> CAPTCHA required (`GET /api/v2/captcha` for provider info) |
| **Rate limits** | 10/1h per user • 30/1h per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `gallery_id` | `integer` | **yes** | — | Gallery Id |

**Request body** — `application/json` (required)

Schema: [`Body_create_suggestion_api_v2_galleries__gallery_id__suggestions_post`](#schema-body-create-suggestion-api-v2-galleries-gallery-id-suggestions-post)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `tag_id` | `integer` | **yes** | exclusive min: `0.0` | Tag Id |
| `action` | `string` enum | no | one of `"add"`, `"remove"`; default: `"add"` | Action |
| `captcha_response` | `string` *(nullable)* | no | — | CAPTCHA response token |
| `pow_challenge` | `string` | **yes** | — | PoW challenge from GET /api/v2/pow. Empty string is fine when the action's difficulty is 0. |
| `pow_nonce` | `string` | **yes** | — | Nonce that solves the PoW challenge. Empty string is fine when the action's difficulty is 0. |

```json
{
  "tag_id": 1234,
  "action": "add",
  "captcha_response": "03AGdBq26k...captcha-token",
  "pow_challenge": "0f3a9c7e21b845d6",
  "pow_nonce": "000000000001a2f7"
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SuggestionResponse`](#schema-suggestionresponse) |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `403` | Forbidden | `application/json` → [`CaptchaErrorResponse`](#schema-captchaerrorresponse) |
| `409` | Conflict | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too Many Requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Service Unavailable | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/galleries/2841902/suggestions' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '{"tag_id": 1234, "action": "add", "captcha_response": "03AGdBq26k...captcha-token", "pow_challenge": "0f3a9c7e21b845d6", "pow_nonce": "000000000001a2f7"}'
```

**Example response** — `200`

```json
{
  "id": "string",
  "gallery_id": 2841902,
  "tag": {
    "id": 1842,
    "type": "tag",
    "name": "example",
    "slug": "example-slug",
    "url": "https://cdn.example.net/galleries/1451234/3.webp",
    "description": "A short human-readable description."
  },
  "action": "add",
  "status": "pending",
  "score": 5,
  "voter_count": 12,
  "proposer": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png"
  },
  "created_at": "2026-05-14T09:21:07Z",
  "resolved_at": "2026-05-14T09:21:07Z",
  "resolver": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png"
  },
  "resolution_note": "Reviewed and approved by staff.",
  "reverted_at": "2026-05-14T09:21:07Z",
  "reverter": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png"
  },
  "my_vote": 1,
  "tier": "trending"
}
```

---

<a id="get-apiv2gtsbacklog"></a>

#### `GET` `/api/v2/gts/backlog`

**List Gts Backlog**

List pending tag-change suggestions across galleries.

| | |
|---|---|
| **Operation ID** | `list_gts_backlog_api_v2_gts_backlog_get` |
| **Auth** | Public (optional User Token or API Key for personalization) |
| **Security schemes** | `User Token` or `API Key` |
| **Feature Flag** | `allow_gts` must be enabled |
| **Rate limits** | 60/1min per IP |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `page` | `integer` | no | min: `1`; max: `200`; default: `1` | Page |
| `per_page` | `integer` | no | min: `1`; max: `50`; default: `20` | Per Page |
| `tag_id` | `integer` *(nullable)* | no | exclusive min: `0` | Tag Id |
| `action` | `string` *(nullable)* | no | pattern: `^(add\|remove)$` | Action |
| `sort_by` | `string` | no | pattern: `^(starvation\|voters\|score\|gallery_age\|created_at)$`; default: `"starvation"` | Sort By |
| `sort` | `string` | no | pattern: `^(asc\|desc)$`; default: `"asc"` | Sort |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`BacklogListResponse`](#schema-backloglistresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/gts/backlog?page=1&per_page=20&sort_by=starvation&sort=asc' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
{
  "result": [
    {
      "suggestion": {
        "id": "string",
        "gallery_id": 2841902,
        "tag": null,
        "action": "add",
        "status": "pending",
        "score": 5,
        "voter_count": 12,
        "proposer": null,
        "created_at": "2026-05-14T09:21:07Z",
        "resolved_at": "2026-05-14T09:21:07Z",
        "resolver": null,
        "resolution_note": "Reviewed and approved by staff.",
        "reverted_at": "2026-05-14T09:21:07Z",
        "reverter": null,
        "my_vote": 1,
        "tier": "trending"
      },
      "gallery": {
        "id": 2841902,
        "media_id": "2841902",
        "thumbnail": "/galleries/2841902/3.webp",
        "thumbnail_width": 1280,
        "thumbnail_height": 1807,
        "english_title": "Example Gallery Title",
        "japanese_title": "サンプルタイトル",
        "num_pages": 24,
        "num_favorites": 12,
        "upload_date": 1778000000,
        "age_days": 1,
        "tags": []
      }
    }
  ],
  "has_more": false,
  "num_pages": 24,
  "total": 1372
}
```

---

<a id="get-apiv2gtsnew-tags"></a>

#### `GET` `/api/v2/gts/new-tags`

**List New Tag Index**

List the most recently community-minted tags.

| | |
|---|---|
| **Operation ID** | `list_new_tag_index_api_v2_gts_new_tags_get` |
| **Auth** | Public (no authentication required) |
| **Security schemes** | None declared |
| **Feature Flag** | `allow_gts` must be enabled |
| **Rate limits** | 60/1min per IP |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `limit` | `integer` | no | min: `1`; max: `50`; default: `25` | Limit |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`NewTagIndexResponse`](#schema-newtagindexresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/gts/new-tags?limit=25' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)'
```

**Example response** — `200`

```json
{
  "result": [
    {
      "tag": {
        "id": 33814,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "count": 12,
        "description": "A short human-readable description.",
        "is_community": false,
        "pending_describe_id": "string"
      },
      "created_at": 1778000000,
      "pending_gts_count": 12
    }
  ]
}
```

---

<a id="post-apiv2galleriesgallery-idsuggestionssuggestion-idvote"></a>

#### `POST` `/api/v2/galleries/{gallery_id}/suggestions/{suggestion_id}/vote`

**Vote On Suggestion**

Up/down vote on a suggestion. Pass vote=0 to clear your vote.

| | |
|---|---|
| **Operation ID** | `vote_on_suggestion_api_v2_galleries__gallery_id__suggestions__suggestion_id__vote_post` |
| **Auth** | User Token required |
| **Security schemes** | `User Token` |
| **Feature Flag** | `allow_gts` must be enabled |
| **Protection** | Proof of Work required (`GET /api/v2/pow?action=gts_vote`) |
| **Rate limits** | 80/1h per user • 240/1h per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `gallery_id` | `integer` | **yes** | — | Gallery Id |
| `suggestion_id` | `string` (`uuid`) | **yes** | format: `uuid` | Suggestion Id |

**Request body** — `application/json` (required)

Schema: [`Body_vote_on_suggestion_api_v2_galleries__gallery_id__suggestions__suggestion_id__vote_post`](#schema-body-vote-on-suggestion-api-v2-galleries-gallery-id-suggestions-suggestion-id-vote-post)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `vote` | `integer` | **yes** | min: `-1.0`; max: `1.0` | Vote |
| `pow_challenge` | `string` | **yes** | — | PoW challenge from GET /api/v2/pow. Empty string is fine when the action's difficulty is 0. |
| `pow_nonce` | `string` | **yes** | — | Nonce that solves the PoW challenge. Empty string is fine when the action's difficulty is 0. |

```json
{
  "vote": -1.0,
  "pow_challenge": "0f3a9c7e21b845d6",
  "pow_nonce": "000000000001a2f7"
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SuggestionResponse`](#schema-suggestionresponse) |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Service Unavailable | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/galleries/2841902/suggestions/string/vote' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '{"vote": -1.0, "pow_challenge": "0f3a9c7e21b845d6", "pow_nonce": "000000000001a2f7"}'
```

**Example response** — `200`

```json
{
  "id": "string",
  "gallery_id": 2841902,
  "tag": {
    "id": 1842,
    "type": "tag",
    "name": "example",
    "slug": "example-slug",
    "url": "https://cdn.example.net/galleries/1451234/3.webp",
    "description": "A short human-readable description."
  },
  "action": "add",
  "status": "pending",
  "score": 5,
  "voter_count": 12,
  "proposer": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png"
  },
  "created_at": "2026-05-14T09:21:07Z",
  "resolved_at": "2026-05-14T09:21:07Z",
  "resolver": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png"
  },
  "resolution_note": "Reviewed and approved by staff.",
  "reverted_at": "2026-05-14T09:21:07Z",
  "reverter": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png"
  },
  "my_vote": 1,
  "tier": "trending"
}
```

---

<a id="delete-apiv2galleriesgallery-idsuggestionssuggestion-id"></a>

#### `DELETE` `/api/v2/galleries/{gallery_id}/suggestions/{suggestion_id}`

**Withdraw Suggestion**

Proposer withdraws their own pending suggestion.

| | |
|---|---|
| **Operation ID** | `withdraw_suggestion_api_v2_galleries__gallery_id__suggestions__suggestion_id__delete` |
| **Auth** | User Token required |
| **Security schemes** | `User Token` |
| **Feature Flag** | `allow_gts` must be enabled |
| **Rate limits** | 20/1h per user |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `gallery_id` | `integer` | **yes** | — | Gallery Id |
| `suggestion_id` | `string` (`uuid`) | **yes** | format: `uuid` | Suggestion Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → `object` |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X DELETE 'https://nhentai.net/api/v2/galleries/2841902/suggestions/string' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{}
```

---

<a id="get-apiv2moderationgts"></a>

#### `GET` `/api/v2/moderation/gts`

**List Pending Suggestions**

Mod queue: proposals awaiting staff review, or recently resolved.

| | |
|---|---|
| **Operation ID** | `list_pending_suggestions_api_v2_moderation_gts_get` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 60/5min per user • 120/5min per IP |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `status` | `string` | no | pattern: `^(pending\|accepted\|rejected)$`; default: `"pending"` | Status |
| `q` | `string` *(nullable)* | no | min length: `1`; max length: `100` | Q |
| `sort` | `string` | no | pattern: `^(score\|voters\|newest\|oldest)$`; default: `"score"` | Sort |
| `tag_type` | `string` *(nullable)* | no | pattern: `^(tag\|artist\|parody\|character\|group\|language\|category)$` | Tag Type |
| `page` | `integer` | no | min: `1`; default: `1` | Page number |
| `per_page` | `integer` | no | min: `1`; max: `100`; default: `25` | Items per page |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SuggestionListResponse`](#schema-suggestionlistresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/moderation/gts?status=pending&sort=score&page=1&per_page=25' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "result": [
    {
      "id": "string",
      "gallery_id": 2841902,
      "tag": {
        "id": 1842,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "description": "A short human-readable description."
      },
      "action": "add",
      "status": "pending",
      "score": 5,
      "voter_count": 12,
      "proposer": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "created_at": "2026-05-14T09:21:07Z",
      "resolved_at": "2026-05-14T09:21:07Z",
      "resolver": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "resolution_note": "Reviewed and approved by staff.",
      "reverted_at": "2026-05-14T09:21:07Z",
      "reverter": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "my_vote": 1,
      "tier": "trending"
    }
  ],
  "has_more": false,
  "num_pages": 24,
  "total": 1372
}
```

---

<a id="post-apiv2moderationgtssuggestion-idaccept"></a>

#### `POST` `/api/v2/moderation/gts/{suggestion_id}/accept`

**Accept Suggestion**

Apply a pending suggestion to the gallery and mark accepted.

| | |
|---|---|
| **Operation ID** | `accept_suggestion_api_v2_moderation_gts__suggestion_id__accept_post` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/15min per user • 60/15min per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `suggestion_id` | `string` (`uuid`) | **yes** | format: `uuid` | Suggestion Id |

**Request body** — `application/json` (required)

Schema: [`ResolveSuggestionRequest`](#schema-resolvesuggestionrequest)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `note` | `string` *(nullable)* | no | max length: `500` | Note |

```json
{
  "note": "Reviewed and approved by staff."
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → `object` |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `409` | Conflict | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/moderation/gts/string/accept' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '{"note": "Reviewed and approved by staff."}'
```

**Example response** — `200`

```json
{}
```

---

<a id="post-apiv2moderationgtssuggestion-idreject"></a>

#### `POST` `/api/v2/moderation/gts/{suggestion_id}/reject`

**Reject Suggestion**

Reject a pending suggestion without applying it.

| | |
|---|---|
| **Operation ID** | `reject_suggestion_api_v2_moderation_gts__suggestion_id__reject_post` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/15min per user • 60/15min per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `suggestion_id` | `string` (`uuid`) | **yes** | format: `uuid` | Suggestion Id |

**Request body** — `application/json` (required)

Schema: [`ResolveSuggestionRequest`](#schema-resolvesuggestionrequest)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `note` | `string` *(nullable)* | no | max length: `500` | Note |

```json
{
  "note": "Reviewed and approved by staff."
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → `object` |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `409` | Conflict | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/moderation/gts/string/reject' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '{"note": "Reviewed and approved by staff."}'
```

**Example response** — `200`

```json
{}
```

---

<a id="post-apiv2moderationgtssuggestion-idrevert"></a>

#### `POST` `/api/v2/moderation/gts/{suggestion_id}/revert`

**Revert Suggestion**

Undo the tag mutation of a previously accepted suggestion.

| | |
|---|---|
| **Operation ID** | `revert_suggestion_api_v2_moderation_gts__suggestion_id__revert_post` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/15min per user • 60/15min per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `suggestion_id` | `string` (`uuid`) | **yes** | format: `uuid` | Suggestion Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → `object` |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `409` | Conflict | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/moderation/gts/string/revert' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{}
```

---

<a id="post-apiv2moderationtags"></a>

#### `POST` `/api/v2/moderation/tags`

**Moderation Create Tag**

Create a new tag. Slug is derived from `name`.

| | |
|---|---|
| **Operation ID** | `moderation_create_tag_api_v2_moderation_tags_post` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |

**Request body** — `application/json` (required)

Schema: [`CreateTagRequest`](#schema-createtagrequest)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `type` | `string` enum | **yes** | one of `"tag"`, `"artist"`, `"parody"`, `"character"`, `"group"`, `"language"`, `"category"` | Type |
| `name` | `string` | **yes** | min length: `1`; max length: `100` | Name |

```json
{
  "type": "tag",
  "name": "example"
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`CreatedTagResponse`](#schema-createdtagresponse) |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `409` | Conflict | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/moderation/tags' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '{"type": "tag", "name": "example"}'
```

**Example response** — `200`

```json
{
  "id": 33814,
  "type": "tag",
  "name": "example",
  "slug": "example-slug",
  "url": "https://cdn.example.net/galleries/1451234/3.webp"
}
```

---

### taxonomy

Community proposals against the global tag taxonomy: create, rename, merge, or describe. Resolved entries are a public ledger with the staff resolution_note attached.

*15 operations.*

<a id="get-apiv2taxonomy"></a>

#### `GET` `/api/v2/taxonomy`

**List Taxonomy Suggestions**

List pending tag suggestions.

| | |
|---|---|
| **Operation ID** | `list_taxonomy_suggestions_api_v2_taxonomy_get` |
| **Auth** | Public (optional User Token or API Key for personalization) |
| **Security schemes** | `User Token` or `API Key` |
| **Feature Flag** | `allow_taxonomy` must be enabled |
| **Rate limits** | 120/1min per IP |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `tier` | `string` | no | pattern: `^(all\|trending\|active\|declined\|mine)$`; default: `"all"` | Tier |
| `page` | `integer` | no | min: `1`; default: `1` | Page |
| `per_page` | `integer` | no | min: `1`; max: `200`; default: `50` | Per Page |
| `q` | `string` *(nullable)* | no | min length: `1`; max length: `100` | Q |
| `target_tag_id` | `integer` *(nullable)* | no | exclusive min: `0` | Target Tag Id |
| `sort_by` | `string` | no | pattern: `^(score\|votes\|comment_count\|last_comment_at\|created_at)$`; default: `"score"` | Field to sort by. score (sum of votes), votes (unique voter count), comment_count, last_comment_at, created_at. |
| `sort` | `string` | no | pattern: `^(asc\|desc)$`; default: `"desc"` | Sort direction. Pairs with sort_by. |
| `action` | `string` *(nullable)* | no | — | Comma-separated subset of create,rename,merge,describe. Defaults to all. |
| `discussion` | `string` *(nullable)* | no | pattern: `^(with\|without)$` | Filter by comment presence: 'with' = has at least one comment, 'without' = none. Omit for any. |
| `edited` | `string` *(nullable)* | no | pattern: `^(yes\|no)$` | Filter by edit status: 'yes' = edited, 'no' = never edited. Omit for any. |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`TaxonomySuggestionListResponse`](#schema-taxonomysuggestionlistresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/taxonomy?tier=all&page=1&per_page=50&sort_by=score' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
{
  "result": [
    {
      "id": "string",
      "action": "create",
      "status": "pending",
      "score": 5,
      "voter_count": 12,
      "proposer": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "proposer_note": "Reviewed and approved by staff.",
      "created_at": "2026-05-14T09:21:07Z",
      "edited_at": "2026-05-14T09:21:07Z",
      "resolved_at": "2026-05-14T09:21:07Z",
      "resolution_note": "Reviewed and approved by staff.",
      "resolver": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "target_tag": {
        "id": 1842,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "count": 12,
        "description": "A short human-readable description."
      },
      "merge_into_tag": {
        "id": 1842,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "count": 12,
        "description": "A short human-readable description."
      },
      "new_name": "example",
      "new_type": "tag",
      "new_description": "A short human-readable description.",
      "accepted_type": "tag",
      "accepted_name": "example",
      "accepted_description": "A short human-readable description.",
      "resolved_tag": {
        "id": 1842,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "count": 12,
        "description": "A short human-readable description."
      },
      "my_vote": 1,
      "tier": "trending",
      "tier_page": 1,
      "comment_count": 12,
      "recent_comments": [
        {
          "id": "string",
          "body": "Thanks for the upload!",
          "author": null,
          "created_at": "2026-05-14T09:21:07Z",
          "can_delete": false,
          "link_previews": []
        }
      ]
    }
  ],
  "has_more": false,
  "num_pages": 24,
  "total": 1372
}
```

---

<a id="post-apiv2taxonomy"></a>

#### `POST` `/api/v2/taxonomy`

**Create Taxonomy Suggestion**

Submit a tag suggestion.

| | |
|---|---|
| **Operation ID** | `create_taxonomy_suggestion_api_v2_taxonomy_post` |
| **Auth** | User Token required |
| **Security schemes** | `User Token` |
| **Feature Flag** | `allow_taxonomy` must be enabled |
| **Protection** | Proof of Work required (`GET /api/v2/pow?action=taxonomy_create`) <br> CAPTCHA required (`GET /api/v2/captcha` for provider info) |
| **Rate limits** | 4/4h per user • 12/4h per IP |

**Request body** — `application/json` (required)

Schema: [`Body_create_taxonomy_suggestion_api_v2_taxonomy_post`](#schema-body-create-taxonomy-suggestion-api-v2-taxonomy-post)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `action` | `string` enum | **yes** | one of `"create"`, `"rename"`, `"merge"`, `"describe"` | Action |
| `target_tag_id` | `integer` *(nullable)* | no | exclusive min: `0.0` | Target Tag Id |
| `merge_into_tag_id` | `integer` *(nullable)* | no | exclusive min: `0.0` | Merge Into Tag Id |
| `new_name` | `string` *(nullable)* | no | min length: `1`; max length: `100` | New Name |
| `new_type` | `string` enum *(nullable)* | no | one of `"tag"`, `"artist"`, `"parody"`, `"character"`, `"group"`, `"language"`, `"category"` | New Type |
| `new_description` | `string` *(nullable)* | no | min length: `1`; max length: `2000` | New Description |
| `proposer_note` | `string` *(nullable)* | no | max length: `500` | Proposer Note |
| `captcha_response` | `string` *(nullable)* | no | — | CAPTCHA response token |
| `pow_challenge` | `string` | **yes** | — | PoW challenge from GET /api/v2/pow. Empty string is fine when the action's difficulty is 0. |
| `pow_nonce` | `string` | **yes** | — | Nonce that solves the PoW challenge. Empty string is fine when the action's difficulty is 0. |

```json
{
  "action": "create",
  "target_tag_id": 1234,
  "merge_into_tag_id": 1234,
  "new_name": "example",
  "new_type": "tag",
  "new_description": "A short human-readable description.",
  "proposer_note": "Reviewed and approved by staff.",
  "captcha_response": "03AGdBq26k...captcha-token",
  "pow_challenge": "0f3a9c7e21b845d6",
  "pow_nonce": "000000000001a2f7"
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`TaxonomySuggestionResponse`](#schema-taxonomysuggestionresponse) |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `403` | Forbidden | `application/json` → [`CaptchaErrorResponse`](#schema-captchaerrorresponse) |
| `409` | Conflict | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too Many Requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Service Unavailable | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/taxonomy' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '{"action": "create", "target_tag_id": 1234, "merge_into_tag_id": 1234, "new_name": "example", "new_type": "tag", "new_description": "A short human-readable description.", "proposer_note": "Reviewed and approved by staff.", "captcha_response": "03AGdBq26k...captcha-token", "pow_challenge": "0f3a9c7e21b845d6", "pow_nonce": "000000000001a2f7"}'
```

**Example response** — `200`

```json
{
  "id": "string",
  "action": "create",
  "status": "pending",
  "score": 5,
  "voter_count": 12,
  "proposer": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png"
  },
  "proposer_note": "Reviewed and approved by staff.",
  "created_at": "2026-05-14T09:21:07Z",
  "edited_at": "2026-05-14T09:21:07Z",
  "resolved_at": "2026-05-14T09:21:07Z",
  "resolution_note": "Reviewed and approved by staff.",
  "resolver": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png"
  },
  "target_tag": {
    "id": 1842,
    "type": "tag",
    "name": "example",
    "slug": "example-slug",
    "url": "https://cdn.example.net/galleries/1451234/3.webp",
    "count": 12,
    "description": "A short human-readable description."
  },
  "merge_into_tag": {
    "id": 1842,
    "type": "tag",
    "name": "example",
    "slug": "example-slug",
    "url": "https://cdn.example.net/galleries/1451234/3.webp",
    "count": 12,
    "description": "A short human-readable description."
  },
  "new_name": "example",
  "new_type": "tag",
  "new_description": "A short human-readable description.",
  "accepted_type": "tag",
  "accepted_name": "example",
  "accepted_description": "A short human-readable description.",
  "resolved_tag": {
    "id": 1842,
    "type": "tag",
    "name": "example",
    "slug": "example-slug",
    "url": "https://cdn.example.net/galleries/1451234/3.webp",
    "count": 12,
    "description": "A short human-readable description."
  },
  "my_vote": 1,
  "tier": "trending",
  "tier_page": 1,
  "comment_count": 12,
  "recent_comments": [
    {
      "id": "string",
      "body": "Thanks for the upload!",
      "author": {
        "id": 4410927,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png",
        "is_staff": false,
        "is_superuser": false
      },
      "created_at": "2026-05-14T09:21:07Z",
      "can_delete": false,
      "link_previews": []
    }
  ]
}
```

---

<a id="get-apiv2taxonomystats"></a>

#### `GET` `/api/v2/taxonomy/stats`

**Get Taxonomy Suggestion Stats**

Taxonomy activity summary: pending count + recently-accepted suggestions.

| | |
|---|---|
| **Operation ID** | `get_taxonomy_suggestion_stats_api_v2_taxonomy_stats_get` |
| **Auth** | Public (no authentication required) |
| **Security schemes** | None declared |
| **Feature Flag** | `allow_taxonomy` must be enabled |
| **Rate limits** | 30/1min per IP |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`TaxonomySuggestionStats`](#schema-taxonomysuggestionstats) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/taxonomy/stats' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)'
```

**Example response** — `200`

```json
{
  "pending": 1,
  "accepted_total": 1372,
  "rejected_total": 1372,
  "accepted_30d": 1,
  "accepted_7d": 1,
  "created_30d": 1,
  "renamed_30d": 1,
  "merged_30d": 1,
  "described_30d": 1,
  "trending_count": 12,
  "active_count": 12,
  "declined_count": 12,
  "recent_accepted": [
    {
      "id": "string",
      "action": "create",
      "status": "pending",
      "score": 5,
      "voter_count": 12,
      "proposer": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "proposer_note": "Reviewed and approved by staff.",
      "created_at": "2026-05-14T09:21:07Z",
      "edited_at": "2026-05-14T09:21:07Z",
      "resolved_at": "2026-05-14T09:21:07Z",
      "resolution_note": "Reviewed and approved by staff.",
      "resolver": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "target_tag": {
        "id": 1842,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "count": 12,
        "description": "A short human-readable description."
      },
      "merge_into_tag": {
        "id": 1842,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "count": 12,
        "description": "A short human-readable description."
      },
      "new_name": "example",
      "new_type": "tag",
      "new_description": "A short human-readable description.",
      "accepted_type": "tag",
      "accepted_name": "example",
      "accepted_description": "A short human-readable description.",
      "resolved_tag": {
        "id": 1842,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "count": 12,
        "description": "A short human-readable description."
      },
      "my_vote": 1,
      "tier": "trending",
      "tier_page": 1,
      "comment_count": 12,
      "recent_comments": [
        {
          "id": "string",
          "body": "Thanks for the upload!",
          "author": null,
          "created_at": "2026-05-14T09:21:07Z",
          "can_delete": false,
          "link_previews": []
        }
      ]
    }
  ]
}
```

---

<a id="get-apiv2taxonomyresolved"></a>

#### `GET` `/api/v2/taxonomy/resolved`

**List Resolved Taxonomy Suggestions**

List resolved tag suggestions.

| | |
|---|---|
| **Operation ID** | `list_resolved_taxonomy_suggestions_api_v2_taxonomy_resolved_get` |
| **Auth** | Public (optional User Token or API Key for personalization) |
| **Security schemes** | `User Token` or `API Key` |
| **Feature Flag** | `allow_taxonomy` must be enabled |
| **Rate limits** | 90/1min per IP |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `status` | `string` | no | pattern: `^(all\|accepted\|rejected)$`; default: `"all"` | Status |
| `q` | `string` *(nullable)* | no | min length: `1`; max length: `100` | Q |
| `discussion` | `string` *(nullable)* | no | pattern: `^(with\|without)$` | Discussion |
| `edited` | `string` *(nullable)* | no | pattern: `^(yes\|no)$` | Edited |
| `action` | `string` *(nullable)* | no | — | Comma-separated subset of create,rename,merge,describe. |
| `sort_by` | `string` | no | pattern: `^(resolved_at\|score\|votes\|comment_count\|last_comment_at\|created_at)$`; default: `"resolved_at"` | Field to sort by. resolved_at (default), score, votes, comment_count, last_comment_at, created_at. |
| `sort` | `string` | no | pattern: `^(asc\|desc)$`; default: `"desc"` | Sort direction. Pairs with sort_by. |
| `page` | `integer` | no | min: `1`; default: `1` | Page number |
| `per_page` | `integer` | no | min: `1`; max: `100`; default: `25` | Items per page |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`TaxonomySuggestionListResponse`](#schema-taxonomysuggestionlistresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/taxonomy/resolved?status=all&sort_by=resolved_at&sort=desc&page=1' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
{
  "result": [
    {
      "id": "string",
      "action": "create",
      "status": "pending",
      "score": 5,
      "voter_count": 12,
      "proposer": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "proposer_note": "Reviewed and approved by staff.",
      "created_at": "2026-05-14T09:21:07Z",
      "edited_at": "2026-05-14T09:21:07Z",
      "resolved_at": "2026-05-14T09:21:07Z",
      "resolution_note": "Reviewed and approved by staff.",
      "resolver": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "target_tag": {
        "id": 1842,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "count": 12,
        "description": "A short human-readable description."
      },
      "merge_into_tag": {
        "id": 1842,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "count": 12,
        "description": "A short human-readable description."
      },
      "new_name": "example",
      "new_type": "tag",
      "new_description": "A short human-readable description.",
      "accepted_type": "tag",
      "accepted_name": "example",
      "accepted_description": "A short human-readable description.",
      "resolved_tag": {
        "id": 1842,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "count": 12,
        "description": "A short human-readable description."
      },
      "my_vote": 1,
      "tier": "trending",
      "tier_page": 1,
      "comment_count": 12,
      "recent_comments": [
        {
          "id": "string",
          "body": "Thanks for the upload!",
          "author": null,
          "created_at": "2026-05-14T09:21:07Z",
          "can_delete": false,
          "link_previews": []
        }
      ]
    }
  ],
  "has_more": false,
  "num_pages": 24,
  "total": 1372
}
```

---

<a id="get-apiv2taxonomysuggestion-id"></a>

#### `GET` `/api/v2/taxonomy/{suggestion_id}`

**Get Taxonomy Suggestion**

Fetch a tag suggestion with its latest comment preview.

| | |
|---|---|
| **Operation ID** | `get_taxonomy_suggestion_api_v2_taxonomy__suggestion_id__get` |
| **Auth** | Public (optional User Token or API Key for personalization) |
| **Security schemes** | `User Token` or `API Key` |
| **Feature Flag** | `allow_taxonomy` must be enabled |
| **Rate limits** | 120/1min per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `suggestion_id` | `string` (`uuid`) | **yes** | format: `uuid` | Suggestion Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`TaxonomySuggestionResponse`](#schema-taxonomysuggestionresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/taxonomy/string' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
{
  "id": "string",
  "action": "create",
  "status": "pending",
  "score": 5,
  "voter_count": 12,
  "proposer": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png"
  },
  "proposer_note": "Reviewed and approved by staff.",
  "created_at": "2026-05-14T09:21:07Z",
  "edited_at": "2026-05-14T09:21:07Z",
  "resolved_at": "2026-05-14T09:21:07Z",
  "resolution_note": "Reviewed and approved by staff.",
  "resolver": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png"
  },
  "target_tag": {
    "id": 1842,
    "type": "tag",
    "name": "example",
    "slug": "example-slug",
    "url": "https://cdn.example.net/galleries/1451234/3.webp",
    "count": 12,
    "description": "A short human-readable description."
  },
  "merge_into_tag": {
    "id": 1842,
    "type": "tag",
    "name": "example",
    "slug": "example-slug",
    "url": "https://cdn.example.net/galleries/1451234/3.webp",
    "count": 12,
    "description": "A short human-readable description."
  },
  "new_name": "example",
  "new_type": "tag",
  "new_description": "A short human-readable description.",
  "accepted_type": "tag",
  "accepted_name": "example",
  "accepted_description": "A short human-readable description.",
  "resolved_tag": {
    "id": 1842,
    "type": "tag",
    "name": "example",
    "slug": "example-slug",
    "url": "https://cdn.example.net/galleries/1451234/3.webp",
    "count": 12,
    "description": "A short human-readable description."
  },
  "my_vote": 1,
  "tier": "trending",
  "tier_page": 1,
  "comment_count": 12,
  "recent_comments": [
    {
      "id": "string",
      "body": "Thanks for the upload!",
      "author": {
        "id": 4410927,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png",
        "is_staff": false,
        "is_superuser": false
      },
      "created_at": "2026-05-14T09:21:07Z",
      "can_delete": false,
      "link_previews": []
    }
  ]
}
```

---

<a id="delete-apiv2taxonomysuggestion-id"></a>

#### `DELETE` `/api/v2/taxonomy/{suggestion_id}`

**Remove Taxonomy Suggestion**

Delete your own pending tag suggestion.

| | |
|---|---|
| **Operation ID** | `remove_taxonomy_suggestion_api_v2_taxonomy__suggestion_id__delete` |
| **Auth** | User Token required |
| **Security schemes** | `User Token` |
| **Feature Flag** | `allow_taxonomy` must be enabled |
| **Rate limits** | 10/1h per user • 20/1h per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `suggestion_id` | `string` (`uuid`) | **yes** | format: `uuid` | Suggestion Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → `object` |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X DELETE 'https://nhentai.net/api/v2/taxonomy/string' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{}
```

---

<a id="patch-apiv2taxonomysuggestion-id"></a>

#### `PATCH` `/api/v2/taxonomy/{suggestion_id}`

**Edit Taxonomy Suggestion**

Edit a pending tag suggestion.

| | |
|---|---|
| **Operation ID** | `edit_taxonomy_suggestion_api_v2_taxonomy__suggestion_id__patch` |
| **Auth** | User Token required |
| **Security schemes** | `User Token` |
| **Feature Flag** | `allow_taxonomy` must be enabled |
| **Rate limits** | 20/1h per user • 40/1h per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `suggestion_id` | `string` (`uuid`) | **yes** | format: `uuid` | Suggestion Id |

**Request body** — `application/json` (required)

Schema: [`Body_edit_taxonomy_suggestion_api_v2_taxonomy__suggestion_id__patch`](#schema-body-edit-taxonomy-suggestion-api-v2-taxonomy-suggestion-id-patch)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `action` | `string` enum | **yes** | one of `"create"`, `"rename"`, `"merge"`, `"describe"` | Action |
| `target_tag_id` | `integer` *(nullable)* | no | exclusive min: `0.0` | Target Tag Id |
| `merge_into_tag_id` | `integer` *(nullable)* | no | exclusive min: `0.0` | Merge Into Tag Id |
| `new_name` | `string` *(nullable)* | no | min length: `1`; max length: `100` | New Name |
| `new_type` | `string` enum *(nullable)* | no | one of `"tag"`, `"artist"`, `"parody"`, `"character"`, `"group"`, `"language"`, `"category"` | New Type |
| `new_description` | `string` *(nullable)* | no | min length: `1`; max length: `2000` | New Description |
| `proposer_note` | `string` *(nullable)* | no | max length: `500` | Proposer Note |
| `summary` | `string` *(nullable)* | no | max length: `500` | Summary |

```json
{
  "action": "create",
  "target_tag_id": 1234,
  "merge_into_tag_id": 1234,
  "new_name": "example",
  "new_type": "tag",
  "new_description": "A short human-readable description.",
  "proposer_note": "Reviewed and approved by staff.",
  "summary": "string"
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`TaxonomySuggestionResponse`](#schema-taxonomysuggestionresponse) |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `409` | Conflict | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too Many Requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X PATCH 'https://nhentai.net/api/v2/taxonomy/string' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '{"action": "create", "target_tag_id": 1234, "merge_into_tag_id": 1234, "new_name": "example", "new_type": "tag", "new_description": "A short human-readable description.", "proposer_note": "Reviewed and approved by staff.", "summary": "string"}'
```

**Example response** — `200`

```json
{
  "id": "string",
  "action": "create",
  "status": "pending",
  "score": 5,
  "voter_count": 12,
  "proposer": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png"
  },
  "proposer_note": "Reviewed and approved by staff.",
  "created_at": "2026-05-14T09:21:07Z",
  "edited_at": "2026-05-14T09:21:07Z",
  "resolved_at": "2026-05-14T09:21:07Z",
  "resolution_note": "Reviewed and approved by staff.",
  "resolver": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png"
  },
  "target_tag": {
    "id": 1842,
    "type": "tag",
    "name": "example",
    "slug": "example-slug",
    "url": "https://cdn.example.net/galleries/1451234/3.webp",
    "count": 12,
    "description": "A short human-readable description."
  },
  "merge_into_tag": {
    "id": 1842,
    "type": "tag",
    "name": "example",
    "slug": "example-slug",
    "url": "https://cdn.example.net/galleries/1451234/3.webp",
    "count": 12,
    "description": "A short human-readable description."
  },
  "new_name": "example",
  "new_type": "tag",
  "new_description": "A short human-readable description.",
  "accepted_type": "tag",
  "accepted_name": "example",
  "accepted_description": "A short human-readable description.",
  "resolved_tag": {
    "id": 1842,
    "type": "tag",
    "name": "example",
    "slug": "example-slug",
    "url": "https://cdn.example.net/galleries/1451234/3.webp",
    "count": 12,
    "description": "A short human-readable description."
  },
  "my_vote": 1,
  "tier": "trending",
  "tier_page": 1,
  "comment_count": 12,
  "recent_comments": [
    {
      "id": "string",
      "body": "Thanks for the upload!",
      "author": {
        "id": 4410927,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png",
        "is_staff": false,
        "is_superuser": false
      },
      "created_at": "2026-05-14T09:21:07Z",
      "can_delete": false,
      "link_previews": []
    }
  ]
}
```

---

<a id="get-apiv2taxonomysuggestion-idcomments"></a>

#### `GET` `/api/v2/taxonomy/{suggestion_id}/comments`

**List Taxonomy Comments**

List comments on a tag suggestion.

| | |
|---|---|
| **Operation ID** | `list_taxonomy_comments_api_v2_taxonomy__suggestion_id__comments_get` |
| **Auth** | Public (optional User Token or API Key for personalization) |
| **Security schemes** | `User Token` or `API Key` |
| **Feature Flag** | `allow_taxonomy` must be enabled |
| **Rate limits** | 120/1min per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `suggestion_id` | `string` (`uuid`) | **yes** | format: `uuid` | Suggestion Id |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `page` | `integer` | no | min: `1`; default: `1` | Page |
| `per_page` | `integer` | no | min: `1`; max: `100`; default: `50` | Per Page |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`TaxonomyCommentListResponse`](#schema-taxonomycommentlistresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/taxonomy/string/comments?page=1&per_page=50' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: Key nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9'
```

**Example response** — `200`

```json
{
  "result": [
    {
      "id": "string",
      "body": "Thanks for the upload!",
      "author": {
        "id": 4410927,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png",
        "is_staff": false,
        "is_superuser": false
      },
      "created_at": "2026-05-14T09:21:07Z",
      "can_delete": false,
      "link_previews": []
    }
  ],
  "has_more": false,
  "num_pages": 24,
  "total": 1372
}
```

---

<a id="post-apiv2taxonomysuggestion-idcomments"></a>

#### `POST` `/api/v2/taxonomy/{suggestion_id}/comments`

**Create Taxonomy Comment**

Post a comment on a tag suggestion.

| | |
|---|---|
| **Operation ID** | `create_taxonomy_comment_api_v2_taxonomy__suggestion_id__comments_post` |
| **Auth** | User Token required |
| **Security schemes** | `User Token` |
| **Feature Flag** | `allow_taxonomy` must be enabled |
| **Protection** | Proof of Work required (`GET /api/v2/pow?action=taxonomy_comment`) <br> CAPTCHA required (`GET /api/v2/captcha` for provider info) |
| **Rate limits** | 5/15min per user • 5/15min per IP + user • 10/15min per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `suggestion_id` | `string` (`uuid`) | **yes** | format: `uuid` | Suggestion Id |

**Request body** — `application/json` (required)

Schema: [`Body_create_taxonomy_comment_api_v2_taxonomy__suggestion_id__comments_post`](#schema-body-create-taxonomy-comment-api-v2-taxonomy-suggestion-id-comments-post)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `body` | `string` | **yes** | min length: `10`; max length: `1000` | Body |
| `captcha_response` | `string` *(nullable)* | no | — | CAPTCHA response token |
| `pow_challenge` | `string` | **yes** | — | PoW challenge from GET /api/v2/pow. Empty string is fine when the action's difficulty is 0. |
| `pow_nonce` | `string` | **yes** | — | Nonce that solves the PoW challenge. Empty string is fine when the action's difficulty is 0. |

```json
{
  "body": "Thanks for the upload!",
  "captcha_response": "03AGdBq26k...captcha-token",
  "pow_challenge": "0f3a9c7e21b845d6",
  "pow_nonce": "000000000001a2f7"
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`TaxonomyCommentResponse`](#schema-taxonomycommentresponse) |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `403` | Forbidden | `application/json` → [`CaptchaErrorResponse`](#schema-captchaerrorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Service Unavailable | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/taxonomy/string/comments' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '{"body": "Thanks for the upload!", "captcha_response": "03AGdBq26k...captcha-token", "pow_challenge": "0f3a9c7e21b845d6", "pow_nonce": "000000000001a2f7"}'
```

**Example response** — `200`

```json
{
  "id": "string",
  "body": "Thanks for the upload!",
  "author": {
    "id": 4410927,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png",
    "is_staff": false,
    "is_superuser": false
  },
  "created_at": "2026-05-14T09:21:07Z",
  "can_delete": false,
  "link_previews": [
    {
      "start": 1,
      "end": 1,
      "matched": "string",
      "kind": "taxonomy",
      "suggestion": {
        "id": "string",
        "action": "create",
        "status": "pending",
        "score": 5,
        "voter_count": 12,
        "proposer": null,
        "proposer_note": "Reviewed and approved by staff.",
        "created_at": "2026-05-14T09:21:07Z",
        "edited_at": "2026-05-14T09:21:07Z",
        "resolved_at": "2026-05-14T09:21:07Z",
        "resolution_note": "Reviewed and approved by staff.",
        "resolver": null,
        "target_tag": null,
        "merge_into_tag": null,
        "new_name": "example",
        "new_type": "tag",
        "new_description": "A short human-readable description.",
        "accepted_type": "tag",
        "accepted_name": "example",
        "accepted_description": "A short human-readable description.",
        "resolved_tag": null,
        "my_vote": 1,
        "tier": "trending",
        "tier_page": 1,
        "comment_count": 12,
        "recent_comments": []
      }
    }
  ]
}
```

---

<a id="delete-apiv2taxonomysuggestion-idcommentscomment-id"></a>

#### `DELETE` `/api/v2/taxonomy/{suggestion_id}/comments/{comment_id}`

**Delete Taxonomy Comment**

Delete a comment. Authors can delete their own; moderators can delete any.

| | |
|---|---|
| **Operation ID** | `delete_taxonomy_comment_api_v2_taxonomy__suggestion_id__comments__comment_id__delete` |
| **Auth** | User Token required |
| **Security schemes** | `User Token` |
| **Feature Flag** | `allow_taxonomy` must be enabled |
| **Rate limits** | 30/15min per user • 60/15min per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `suggestion_id` | `string` (`uuid`) | **yes** | format: `uuid` | Suggestion Id |
| `comment_id` | `string` (`uuid`) | **yes** | format: `uuid` | Comment Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → `object` |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X DELETE 'https://nhentai.net/api/v2/taxonomy/string/comments/Thanks for the upload!' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{}
```

---

<a id="post-apiv2taxonomysuggestion-idvote"></a>

#### `POST` `/api/v2/taxonomy/{suggestion_id}/vote`

**Vote On Taxonomy Suggestion**

Vote on a tag suggestion. Pass vote=0 to clear.

| | |
|---|---|
| **Operation ID** | `vote_on_taxonomy_suggestion_api_v2_taxonomy__suggestion_id__vote_post` |
| **Auth** | User Token required |
| **Security schemes** | `User Token` |
| **Feature Flag** | `allow_taxonomy` must be enabled |
| **Protection** | Proof of Work required (`GET /api/v2/pow?action=taxonomy_vote`) |
| **Rate limits** | 30/1h per user • 60/1h per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `suggestion_id` | `string` (`uuid`) | **yes** | format: `uuid` | Suggestion Id |

**Request body** — `application/json` (required)

Schema: [`Body_vote_on_taxonomy_suggestion_api_v2_taxonomy__suggestion_id__vote_post`](#schema-body-vote-on-taxonomy-suggestion-api-v2-taxonomy-suggestion-id-vote-post)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `vote` | `integer` | **yes** | min: `-1.0`; max: `1.0` | Vote |
| `pow_challenge` | `string` | **yes** | — | PoW challenge from GET /api/v2/pow. Empty string is fine when the action's difficulty is 0. |
| `pow_nonce` | `string` | **yes** | — | Nonce that solves the PoW challenge. Empty string is fine when the action's difficulty is 0. |

```json
{
  "vote": -1.0,
  "pow_challenge": "0f3a9c7e21b845d6",
  "pow_nonce": "000000000001a2f7"
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`TaxonomySuggestionResponse`](#schema-taxonomysuggestionresponse) |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Service Unavailable | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/taxonomy/string/vote' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '{"vote": -1.0, "pow_challenge": "0f3a9c7e21b845d6", "pow_nonce": "000000000001a2f7"}'
```

**Example response** — `200`

```json
{
  "id": "string",
  "action": "create",
  "status": "pending",
  "score": 5,
  "voter_count": 12,
  "proposer": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png"
  },
  "proposer_note": "Reviewed and approved by staff.",
  "created_at": "2026-05-14T09:21:07Z",
  "edited_at": "2026-05-14T09:21:07Z",
  "resolved_at": "2026-05-14T09:21:07Z",
  "resolution_note": "Reviewed and approved by staff.",
  "resolver": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png"
  },
  "target_tag": {
    "id": 1842,
    "type": "tag",
    "name": "example",
    "slug": "example-slug",
    "url": "https://cdn.example.net/galleries/1451234/3.webp",
    "count": 12,
    "description": "A short human-readable description."
  },
  "merge_into_tag": {
    "id": 1842,
    "type": "tag",
    "name": "example",
    "slug": "example-slug",
    "url": "https://cdn.example.net/galleries/1451234/3.webp",
    "count": 12,
    "description": "A short human-readable description."
  },
  "new_name": "example",
  "new_type": "tag",
  "new_description": "A short human-readable description.",
  "accepted_type": "tag",
  "accepted_name": "example",
  "accepted_description": "A short human-readable description.",
  "resolved_tag": {
    "id": 1842,
    "type": "tag",
    "name": "example",
    "slug": "example-slug",
    "url": "https://cdn.example.net/galleries/1451234/3.webp",
    "count": 12,
    "description": "A short human-readable description."
  },
  "my_vote": 1,
  "tier": "trending",
  "tier_page": 1,
  "comment_count": 12,
  "recent_comments": [
    {
      "id": "string",
      "body": "Thanks for the upload!",
      "author": {
        "id": 4410927,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png",
        "is_staff": false,
        "is_superuser": false
      },
      "created_at": "2026-05-14T09:21:07Z",
      "can_delete": false,
      "link_previews": []
    }
  ]
}
```

---

<a id="get-apiv2taxonomysuggestion-idedits"></a>

#### `GET` `/api/v2/taxonomy/{suggestion_id}/edits`

**List Taxonomy Edits**

List a suggestion's edit history.

| | |
|---|---|
| **Operation ID** | `list_taxonomy_edits_api_v2_taxonomy__suggestion_id__edits_get` |
| **Auth** | Public (no authentication required) |
| **Security schemes** | None declared |
| **Feature Flag** | `allow_taxonomy` must be enabled |
| **Rate limits** | 120/1min per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `suggestion_id` | `string` (`uuid`) | **yes** | format: `uuid` | Suggestion Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`TaxonomySuggestionEditListResponse`](#schema-taxonomysuggestioneditlistresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/taxonomy/string/edits' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)'
```

**Example response** — `200`

```json
{
  "result": [
    {
      "id": "string",
      "created_at": "2026-05-14T09:21:07Z",
      "summary": "string",
      "changes": [
        {
          "field": "string",
          "old_value": "string",
          "new_value": "string"
        }
      ],
      "editor": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      }
    }
  ]
}
```

---

<a id="post-apiv2moderationtaxonomysuggestion-idaccept"></a>

#### `POST` `/api/v2/moderation/taxonomy/{suggestion_id}/accept`

**Accept Taxonomy Suggestion**

Accept a tag suggestion.

| | |
|---|---|
| **Operation ID** | `accept_taxonomy_suggestion_api_v2_moderation_taxonomy__suggestion_id__accept_post` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/15min per user • 60/15min per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `suggestion_id` | `string` (`uuid`) | **yes** | format: `uuid` | Suggestion Id |

**Request body** — `application/json` (required)

Schema: [`ResolveTaxonomySuggestionRequest`](#schema-resolvetaxonomysuggestionrequest)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `note` | `string` *(nullable)* | no | max length: `500` | Note |
| `name_override` | `string` *(nullable)* | no | min length: `1`; max length: `100` | Name Override |
| `description_override` | `string` *(nullable)* | no | max length: `2000` | Description Override |

```json
{
  "note": "Reviewed and approved by staff.",
  "name_override": "example",
  "description_override": "A short human-readable description."
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → `object` |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `409` | Conflict | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/moderation/taxonomy/string/accept' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '{"note": "Reviewed and approved by staff.", "name_override": "example", "description_override": "A short human-readable description."}'
```

**Example response** — `200`

```json
{}
```

---

<a id="delete-apiv2moderationtaxonomysuggestion-id"></a>

#### `DELETE` `/api/v2/moderation/taxonomy/{suggestion_id}`

**Delete Taxonomy Suggestion**

Permanently remove a tag suggestion. Reserved for spam and abuse.

| | |
|---|---|
| **Operation ID** | `delete_taxonomy_suggestion_api_v2_moderation_taxonomy__suggestion_id__delete` |
| **Auth** | Superuser Token required |
| **Security schemes** | `User Token` |
| **Feature Flag** | `allow_taxonomy` must be enabled |
| **Rate limits** | 30/15min per user • 60/15min per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `suggestion_id` | `string` (`uuid`) | **yes** | format: `uuid` | Suggestion Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → `object` |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `503` | Feature is currently disabled | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X DELETE 'https://nhentai.net/api/v2/moderation/taxonomy/string' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{}
```

---

<a id="post-apiv2moderationtaxonomysuggestion-idreject"></a>

#### `POST` `/api/v2/moderation/taxonomy/{suggestion_id}/reject`

**Reject Taxonomy Suggestion**

Reject a tag suggestion.

| | |
|---|---|
| **Operation ID** | `reject_taxonomy_suggestion_api_v2_moderation_taxonomy__suggestion_id__reject_post` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/15min per user • 60/15min per IP |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `suggestion_id` | `string` (`uuid`) | **yes** | format: `uuid` | Suggestion Id |

**Request body** — `application/json` (required)

Schema: [`ResolveTaxonomySuggestionRequest`](#schema-resolvetaxonomysuggestionrequest)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `note` | `string` *(nullable)* | no | max length: `500` | Note |
| `name_override` | `string` *(nullable)* | no | min length: `1`; max length: `100` | Name Override |
| `description_override` | `string` *(nullable)* | no | max length: `2000` | Description Override |

```json
{
  "note": "Reviewed and approved by staff.",
  "name_override": "example",
  "description_override": "A short human-readable description."
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → `object` |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `409` | Conflict | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/moderation/taxonomy/string/reject' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '{"note": "Reviewed and approved by staff.", "name_override": "example", "description_override": "A short human-readable description."}'
```

**Example response** — `200`

```json
{}
```

---

### moderation

Staff-only moderation tools.

*27 operations.*

<a id="get-apiv2moderationusersuser-id"></a>

#### `GET` `/api/v2/moderation/users/{user_id}`

**Get User Mod Info**

Get moderation info for a user. Staff sees shadowban, admins also see email.

| | |
|---|---|
| **Operation ID** | `get_user_mod_info_api_v2_moderation_users__user_id__get` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `user_id` | `integer` | **yes** | — | User Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`ModerationUserInfo`](#schema-moderationuserinfo) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/moderation/users/90210' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "id": 90210,
  "is_shadowbanned": false,
  "email": "user@example.com"
}
```

---

<a id="delete-apiv2moderationusersuser-id"></a>

#### `DELETE` `/api/v2/moderation/users/{user_id}`

**Delete User**

Delete a user account. Cascades user-owned content. Staff only.

| | |
|---|---|
| **Operation ID** | `delete_user_api_v2_moderation_users__user_id__delete` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 10/15min per user |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `user_id` | `integer` | **yes** | — | User Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → `object` |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X DELETE 'https://nhentai.net/api/v2/moderation/users/90210' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{}
```

---

<a id="put-apiv2moderationusersuser-idshadowban"></a>

#### `PUT` `/api/v2/moderation/users/{user_id}/shadowban`

**Shadowban User**

Shadowban a user. Staff only.

| | |
|---|---|
| **Operation ID** | `shadowban_user_api_v2_moderation_users__user_id__shadowban_put` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/15min per user |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `user_id` | `integer` | **yes** | — | User Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`ShadowbanResponse`](#schema-shadowbanresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X PUT 'https://nhentai.net/api/v2/moderation/users/90210/shadowban' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "shadowbanned": false
}
```

---

<a id="delete-apiv2moderationusersuser-idshadowban"></a>

#### `DELETE` `/api/v2/moderation/users/{user_id}/shadowban`

**Unshadowban User**

Remove shadowban from a user. Staff only.

| | |
|---|---|
| **Operation ID** | `unshadowban_user_api_v2_moderation_users__user_id__shadowban_delete` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/15min per user |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `user_id` | `integer` | **yes** | — | User Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`ShadowbanResponse`](#schema-shadowbanresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X DELETE 'https://nhentai.net/api/v2/moderation/users/90210/shadowban' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "shadowbanned": false
}
```

---

<a id="get-apiv2moderationgallerieshidden"></a>

#### `GET` `/api/v2/moderation/galleries/hidden`

**List Hidden Galleries**

List hidden galleries newest-first.

| | |
|---|---|
| **Operation ID** | `list_hidden_galleries_api_v2_moderation_galleries_hidden_get` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `page` | `integer` | no | min: `1`; default: `1` | Page number |
| `per_page` | `integer` | no | min: `1`; max: `100`; default: `25` | Items per page |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`PaginatedResponse_GalleryListItem_`](#schema-paginatedresponse-gallerylistitem-) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/moderation/galleries/hidden?page=1&per_page=25' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "result": [
    {
      "id": 2841902,
      "media_id": "2841902",
      "english_title": "Example Gallery Title",
      "japanese_title": "サンプルタイトル",
      "thumbnail": "/galleries/2841902/3.webp",
      "thumbnail_width": 1280,
      "thumbnail_height": 1807,
      "num_pages": 24,
      "num_favorites": 12,
      "tag_ids": [
        1234
      ],
      "blacklisted": false
    }
  ],
  "num_pages": 24,
  "per_page": 25,
  "total": 1372
}
```

---

<a id="get-apiv2moderationgalleriesgallery-id"></a>

#### `GET` `/api/v2/moderation/galleries/{gallery_id}`

**Get Gallery Mod Info**

Get moderation status for a gallery.

| | |
|---|---|
| **Operation ID** | `get_gallery_mod_info_api_v2_moderation_galleries__gallery_id__get` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `gallery_id` | `integer` | **yes** | — | Gallery Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`ModerationGalleryInfo`](#schema-moderationgalleryinfo) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/moderation/galleries/2841902' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "id": 2841902,
  "hidden": false
}
```

---

<a id="put-apiv2moderationgalleriesgallery-idhidden"></a>

#### `PUT` `/api/v2/moderation/galleries/{gallery_id}/hidden`

**Hide Gallery**

Hide a gallery from public reads. Staff only.

| | |
|---|---|
| **Operation ID** | `hide_gallery_api_v2_moderation_galleries__gallery_id__hidden_put` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/15min per user |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `gallery_id` | `integer` | **yes** | — | Gallery Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`HiddenGalleryResponse`](#schema-hiddengalleryresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X PUT 'https://nhentai.net/api/v2/moderation/galleries/2841902/hidden' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "id": 2841902,
  "hidden": false
}
```

---

<a id="delete-apiv2moderationgalleriesgallery-idhidden"></a>

#### `DELETE` `/api/v2/moderation/galleries/{gallery_id}/hidden`

**Unhide Gallery**

Reveal a previously-hidden gallery. Staff only.

| | |
|---|---|
| **Operation ID** | `unhide_gallery_api_v2_moderation_galleries__gallery_id__hidden_delete` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/15min per user |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `gallery_id` | `integer` | **yes** | — | Gallery Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`HiddenGalleryResponse`](#schema-hiddengalleryresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X DELETE 'https://nhentai.net/api/v2/moderation/galleries/2841902/hidden' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "id": 2841902,
  "hidden": false
}
```

---

<a id="post-apiv2commentsflagsflag-idreview"></a>

#### `POST` `/api/v2/comments/flags/{flag_id}/review`

**Review Comment Flag**

Review a comment flag.

Actions:
- approve: Accept the flag and hide the comment
- reject: Reject the flag, no action taken

Staff only.

| | |
|---|---|
| **Operation ID** | `review_comment_flag_api_v2_comments_flags__flag_id__review_post` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/15min per user |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `flag_id` | `integer` | **yes** | — | Flag Id |

**Request body** — `application/json` (required)

Schema: [`ReviewFlagRequest`](#schema-reviewflagrequest)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `action` | `string` enum | **yes** | one of `"approve"`, `"reject"` | Action |

```json
{
  "action": "approve"
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`ReviewFlagResponse`](#schema-reviewflagresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/comments/flags/1842/review' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '{"action": "approve"}'
```

**Example response** — `200`

```json
{
  "success": true,
  "is_user_shadowbanned": false
}
```

---

<a id="get-apiv2moderationflags"></a>

#### `GET` `/api/v2/moderation/flags`

**Get Pending Flags**

Get pending (unreviewed) comment flags. Staff only.

| | |
|---|---|
| **Operation ID** | `get_pending_flags_api_v2_moderation_flags_get` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `page` | `integer` | no | min: `1`; default: `1` | Page |
| `per_page` | `integer` | no | min: `1`; max: `200`; default: `50` | Per Page |
| `q` | `string` *(nullable)* | no | — | Search by username or comment body |
| `hide_shadowbanned` | `boolean` | no | default: `true` | Exclude flags on shadowbanned users' comments |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`ModerationFlagsListResponse`](#schema-moderationflagslistresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/moderation/flags?page=1&per_page=50&hide_shadowbanned=True' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "flags": [
    {
      "id": 1842,
      "user_id": 90210,
      "comment_id": 4410927,
      "reason": "Duplicate of an existing entry",
      "date": 1778000000,
      "poster_id": 1234,
      "poster_username": "example_user",
      "poster_slug": "example-slug",
      "poster_avatar": "https://cdn.example.net/avatars/90210.png",
      "poster_is_shadowbanned": false,
      "reporter_username": "example_user",
      "reporter_slug": "example-slug",
      "reporter_avatar": "https://cdn.example.net/avatars/90210.png",
      "comment_body": "Thanks for the upload!",
      "gallery_id": 2841902,
      "gallery_title": "example"
    }
  ],
  "total": 1372,
  "page": 1,
  "per_page": 25,
  "num_pages": 24
}
```

---

<a id="get-apiv2moderationedits"></a>

#### `GET` `/api/v2/moderation/edits`

**Get Pending Edits**

Retired. Tag changes go through the suggestion flow now.

| | |
|---|---|
| **Operation ID** | `get_pending_edits_api_v2_moderation_edits_get` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `limit` | `integer` | no | min: `1`; max: `200`; default: `50` | Limit |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`EditListResponse`](#schema-editlistresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/moderation/edits?limit=50' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "edits": [
    {
      "id": 1842,
      "user_id": 90210,
      "user_username": "example_user",
      "gallery_id": 2841902,
      "gallery_title": "example",
      "date": 1778000000,
      "accepted": false,
      "added_tags": [
        {
          "id": 1842,
          "type": "tag",
          "name": "example",
          "slug": "example-slug",
          "count": 12,
          "action": "login"
        }
      ],
      "removed_tags": [
        {
          "id": 1842,
          "type": "tag",
          "name": "example",
          "slug": "example-slug",
          "count": 12,
          "action": "login"
        }
      ],
      "created_tags": [
        {
          "type": "tag",
          "name": "example"
        }
      ],
      "upvotes": 5,
      "downvotes": 5,
      "user_vote": false
    }
  ],
  "count": 12
}
```

---

<a id="get-apiv2moderationeditsedit-id"></a>

#### `GET` `/api/v2/moderation/edits/{edit_id}`

**Get Edit**

Retired. Tag changes go through the suggestion flow now.

| | |
|---|---|
| **Operation ID** | `get_edit_api_v2_moderation_edits__edit_id__get` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `edit_id` | `integer` | **yes** | — | Edit Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`EditResponse`](#schema-editresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/moderation/edits/1842' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "id": 1842,
  "user_id": 90210,
  "user_username": "example_user",
  "gallery_id": 2841902,
  "gallery_title": "example",
  "date": 1778000000,
  "accepted": false,
  "added_tags": [
    {
      "id": 1842,
      "type": "tag",
      "name": "example",
      "slug": "example-slug",
      "count": 12,
      "action": "login"
    }
  ],
  "removed_tags": [
    {
      "id": 1842,
      "type": "tag",
      "name": "example",
      "slug": "example-slug",
      "count": 12,
      "action": "login"
    }
  ],
  "created_tags": [
    {
      "type": "tag",
      "name": "example"
    }
  ],
  "upvotes": 5,
  "downvotes": 5,
  "user_vote": false
}
```

---

<a id="post-apiv2moderationeditsedit-idvote"></a>

#### `POST` `/api/v2/moderation/edits/{edit_id}/vote`

**Vote On Edit**

Retired. Tag changes go through the suggestion flow now.

| | |
|---|---|
| **Operation ID** | `vote_on_edit_api_v2_moderation_edits__edit_id__vote_post` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/15min per user |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `edit_id` | `integer` | **yes** | — | Edit Id |

**Request body** — `application/json` (required)

Schema: [`VoteRequest`](#schema-voterequest)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `accept` | `boolean` | **yes** | — | Accept |

```json
{
  "accept": false
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`VoteResponse`](#schema-voteresponse) |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/moderation/edits/1842/vote' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '{"accept": false}'
```

**Example response** — `200`

```json
{
  "success": true,
  "upvotes": 5,
  "downvotes": 5
}
```

---

<a id="post-apiv2moderationeditsedit-idapply"></a>

#### `POST` `/api/v2/moderation/edits/{edit_id}/apply`

**Apply Edit**

Retired. Tag changes go through the suggestion flow now.

| | |
|---|---|
| **Operation ID** | `apply_edit_api_v2_moderation_edits__edit_id__apply_post` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/15min per user |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `edit_id` | `integer` | **yes** | — | Edit Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SuccessResponse`](#schema-successresponse) |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/moderation/edits/1842/apply' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "success": true,
  "message": "Thanks for the upload!"
}
```

---

<a id="post-apiv2moderationeditsedit-idreject"></a>

#### `POST` `/api/v2/moderation/edits/{edit_id}/reject`

**Reject Edit**

Retired. Tag changes go through the suggestion flow now.

| | |
|---|---|
| **Operation ID** | `reject_edit_api_v2_moderation_edits__edit_id__reject_post` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/15min per user |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `edit_id` | `integer` | **yes** | — | Edit Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SuccessResponse`](#schema-successresponse) |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/moderation/edits/1842/reject' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "success": true,
  "message": "Thanks for the upload!"
}
```

---

<a id="get-apiv2moderationcommentsrecent"></a>

#### `GET` `/api/v2/moderation/comments/recent`

**Get Recent Comments**

Get recent visible comments. Admin only.

| | |
|---|---|
| **Operation ID** | `get_recent_comments_api_v2_moderation_comments_recent_get` |
| **Auth** | Superuser Token required |
| **Security schemes** | `User Token` |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `page` | `integer` | no | min: `1`; default: `1` | Page |
| `per_page` | `integer` | no | min: `1`; max: `500`; default: `100` | Per Page |
| `q` | `string` *(nullable)* | no | — | Search by username or comment body |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`ModerationCommentsListResponse`](#schema-moderationcommentslistresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/moderation/comments/recent?page=1&per_page=100' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "comments": [
    {
      "id": 4410927,
      "gallery_id": 2841902,
      "gallery_title": "example",
      "poster_id": 1234,
      "poster_username": "example_user",
      "poster_slug": "example-slug",
      "poster_avatar": "https://cdn.example.net/avatars/90210.png",
      "poster_is_shadowbanned": false,
      "body": "Thanks for the upload!",
      "post_date": 1778000000,
      "is_hidden": false
    }
  ],
  "total": 1372,
  "page": 1,
  "per_page": 25,
  "num_pages": 24
}
```

---

<a id="get-apiv2moderationcommentsspam"></a>

#### `GET` `/api/v2/moderation/comments/spam`

**Get Spam Comments**

Get spam/hidden comments. Admin only.

| | |
|---|---|
| **Operation ID** | `get_spam_comments_api_v2_moderation_comments_spam_get` |
| **Auth** | Superuser Token required |
| **Security schemes** | `User Token` |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `page` | `integer` | no | min: `1`; default: `1` | Page |
| `per_page` | `integer` | no | min: `1`; max: `500`; default: `100` | Per Page |
| `q` | `string` *(nullable)* | no | — | Search by username or comment body |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`ModerationCommentsListResponse`](#schema-moderationcommentslistresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/moderation/comments/spam?page=1&per_page=100' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "comments": [
    {
      "id": 4410927,
      "gallery_id": 2841902,
      "gallery_title": "example",
      "poster_id": 1234,
      "poster_username": "example_user",
      "poster_slug": "example-slug",
      "poster_avatar": "https://cdn.example.net/avatars/90210.png",
      "poster_is_shadowbanned": false,
      "body": "Thanks for the upload!",
      "post_date": 1778000000,
      "is_hidden": false
    }
  ],
  "total": 1372,
  "page": 1,
  "per_page": 25,
  "num_pages": 24
}
```

---

<a id="put-apiv2moderationcommentscomment-idhide"></a>

#### `PUT` `/api/v2/moderation/comments/{comment_id}/hide`

**Hide Comment**

Hide a comment. Staff only.

| | |
|---|---|
| **Operation ID** | `hide_comment_api_v2_moderation_comments__comment_id__hide_put` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/15min per user |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `comment_id` | `integer` | **yes** | — | Comment Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SuccessResponse`](#schema-successresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X PUT 'https://nhentai.net/api/v2/moderation/comments/4410927/hide' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "success": true,
  "message": "Thanks for the upload!"
}
```

---

<a id="delete-apiv2moderationcommentscomment-idhide"></a>

#### `DELETE` `/api/v2/moderation/comments/{comment_id}/hide`

**Unhide Comment**

Unhide a comment. Staff only.

| | |
|---|---|
| **Operation ID** | `unhide_comment_api_v2_moderation_comments__comment_id__hide_delete` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/15min per user |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `comment_id` | `integer` | **yes** | — | Comment Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SuccessResponse`](#schema-successresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X DELETE 'https://nhentai.net/api/v2/moderation/comments/4410927/hide' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "success": true,
  "message": "Thanks for the upload!"
}
```

---

<a id="post-apiv2moderationbulkhide"></a>

#### `POST` `/api/v2/moderation/bulk/hide`

**Bulk Hide**

Hide multiple comments. Staff only.

| | |
|---|---|
| **Operation ID** | `bulk_hide_api_v2_moderation_bulk_hide_post` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/15min per user |

**Request body** — `application/json` (required)

```json
[
  1
]
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SuccessResponse`](#schema-successresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/moderation/bulk/hide' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '[1]'
```

**Example response** — `200`

```json
{
  "success": true,
  "message": "Thanks for the upload!"
}
```

---

<a id="post-apiv2moderationbulkunhide"></a>

#### `POST` `/api/v2/moderation/bulk/unhide`

**Bulk Unhide**

Unhide multiple comments. Staff only.

| | |
|---|---|
| **Operation ID** | `bulk_unhide_api_v2_moderation_bulk_unhide_post` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/15min per user |

**Request body** — `application/json` (required)

```json
[
  1
]
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SuccessResponse`](#schema-successresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/moderation/bulk/unhide' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '[1]'
```

**Example response** — `200`

```json
{
  "success": true,
  "message": "Thanks for the upload!"
}
```

---

<a id="post-apiv2moderationbulkshadowban"></a>

#### `POST` `/api/v2/moderation/bulk/shadowban`

**Bulk Shadowban**

Shadowban multiple users. Staff only.

| | |
|---|---|
| **Operation ID** | `bulk_shadowban_api_v2_moderation_bulk_shadowban_post` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/15min per user |

**Request body** — `application/json` (required)

```json
[
  1
]
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SuccessResponse`](#schema-successresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/moderation/bulk/shadowban' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '[1]'
```

**Example response** — `200`

```json
{
  "success": true,
  "message": "Thanks for the upload!"
}
```

---

<a id="post-apiv2moderationbulkunshadowban"></a>

#### `POST` `/api/v2/moderation/bulk/unshadowban`

**Bulk Unshadowban**

Unshadowban multiple users. Staff only.

| | |
|---|---|
| **Operation ID** | `bulk_unshadowban_api_v2_moderation_bulk_unshadowban_post` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/15min per user |

**Request body** — `application/json` (required)

```json
[
  1
]
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SuccessResponse`](#schema-successresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/moderation/bulk/unshadowban' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '[1]'
```

**Example response** — `200`

```json
{
  "success": true,
  "message": "Thanks for the upload!"
}
```

---

<a id="get-apiv2moderationapi-keys"></a>

#### `GET` `/api/v2/moderation/api-keys`

**List All Api Keys**

List all active API keys with user info. Admin only.

| | |
|---|---|
| **Operation ID** | `list_all_api_keys_api_v2_moderation_api_keys_get` |
| **Auth** | Superuser Token required |
| **Security schemes** | `User Token` |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `page` | `integer` | no | min: `1`; default: `1` | Page |
| `per_page` | `integer` | no | min: `1`; max: `200`; default: `50` | Per Page |
| `sort` | `string` enum | no | one of `"created"`, `"last_used"`; default: `"created"` | Sort |
| `has_purpose` | `boolean` *(nullable)* | no | — | True = only with purpose set; False = only without |
| `q` | `string` | no | max length: `200`; default: `""` | Substring match on name or purpose |
| `key_id` | `string` *(nullable)* | no | — | Exact key id; returns 0 or 1 result |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`ModerationApiKeysListResponse`](#schema-moderationapikeyslistresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/moderation/api-keys?page=1&per_page=50&sort=created&q=artist%3Aexample%20language%3Aenglish' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "keys": [
    {
      "id": "string",
      "key_prefix": "string",
      "name": "example",
      "purpose": "string",
      "scopes": [],
      "created_at": "string",
      "last_used_at": "string",
      "user_id": 90210,
      "username": "example_user",
      "user_slug": "example-slug"
    }
  ],
  "total": 1372,
  "page": 1,
  "per_page": 25,
  "num_pages": 24
}
```

---

<a id="delete-apiv2moderationapi-keyskey-id"></a>

#### `DELETE` `/api/v2/moderation/api-keys/{key_id}`

**Revoke Api Key Admin**

Revoke any API key. Admin only.

| | |
|---|---|
| **Operation ID** | `revoke_api_key_admin_api_v2_moderation_api_keys__key_id__delete` |
| **Auth** | Superuser Token required |
| **Security schemes** | `User Token` |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `key_id` | `string` | **yes** | — | Key Id |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SuccessResponse`](#schema-successresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |

**Example request**

```bash
curl -X DELETE 'https://nhentai.net/api/v2/moderation/api-keys/string' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{
  "success": true,
  "message": "Thanks for the upload!"
}
```

---

<a id="get-apiv2moderationspamconfig"></a>

#### `GET` `/api/v2/moderation/spam/config`

**Get Spam Config**

Staff only.

| | |
|---|---|
| **Operation ID** | `get_spam_config_api_v2_moderation_spam_config_get` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → `object` |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/moderation/spam/config' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**Example response** — `200`

```json
{}
```

---

<a id="put-apiv2moderationspamconfigname"></a>

#### `PUT` `/api/v2/moderation/spam/config/{name}`

**Update Spam Config**

Staff only.

| | |
|---|---|
| **Operation ID** | `update_spam_config_api_v2_moderation_spam_config__name__put` |
| **Auth** | Staff Token required |
| **Security schemes** | `User Token` |
| **Rate limits** | 30/15min per user |

**Path parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | `string` | **yes** | — | Name |

**Request body** — `application/json` (required)

Schema: [`Body_update_spam_config_api_v2_moderation_spam_config__name__put`](#schema-body-update-spam-config-api-v2-moderation-spam-config-name-put)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `items` | array of `string` | **yes** | — | Items |

```json
{
  "items": [
    "string"
  ]
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`SuccessResponse`](#schema-successresponse) |
| `400` | Bad Request | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `403` | Forbidden | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `404` | Not Found | `application/json` → [`ErrorResponse`](#schema-errorresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |
| `429` | Too many requests | `application/json` → [`ErrorResponse`](#schema-errorresponse) |

**Example request**

```bash
curl -X PUT 'https://nhentai.net/api/v2/moderation/spam/config/example' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'Authorization: User eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json' \
  -d '{"items": ["string"]}'
```

**Example response** — `200`

```json
{
  "success": true,
  "message": "Thanks for the upload!"
}
```

---

### zones

*4 operations.*

<a id="get-apiv2zones"></a>

#### `GET` `/api/v2/zones`

**Get Zones**

Slot instructions for this request: HTML for paid inventory, named
creatives for house ads. Missing keys = empty slots. House creatives
are gated per-creative on CF-IPCountry.

| | |
|---|---|
| **Operation ID** | `get_zones_api_v2_zones_get` |
| **Auth** | Public (no authentication required) |
| **Security schemes** | None declared |

**Header parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `user-agent` | `string` | no | — | User-Agent |
| `cf-ipcountry` | `string` | no | default: `""` | Cf-Ipcountry |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`ZonesResponse`](#schema-zonesresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/zones' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'user-agent: string' \
  -H 'cf-ipcountry: string'
```

**Example response** — `200`

```json
{
  "zones": {
    "header": {
      "type": "html",
      "html": "<div id=\"ad-slot\"></div>"
    }
  }
}
```

---

<a id="get-apiv2zonesi"></a>

#### `GET` `/api/v2/zones/i`

**Get Popunder Inventory**

Get available popunder for current user.

Returns the next popunder to show with timing info.
delta is in milliseconds (0 means ready to show).

| | |
|---|---|
| **Operation ID** | `get_popunder_inventory_api_v2_zones_i_get` |
| **Auth** | Public (no authentication required) |
| **Security schemes** | None declared |

**Header parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `user-agent` | `string` | no | — | User-Agent |
| `cf-ipcountry` | `string` | no | default: `""` | Cf-Ipcountry |

**Cookie parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `tor_session` | `string` *(nullable)* | no | — | Tor Session |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`PopunderInventoryResponse`](#schema-popunderinventoryresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/zones/i' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'user-agent: string' \
  -H 'cf-ipcountry: string'
```

**Example response** — `200`

```json
{
  "name": "example",
  "delta": 1
}
```

---

<a id="post-apiv2zonesh"></a>

#### `POST` `/api/v2/zones/h`

**Record Popunder Hit**

Record a popunder impression/open event.

Called by frontend when a popunder is triggered.

| | |
|---|---|
| **Operation ID** | `record_popunder_hit_api_v2_zones_h_post` |
| **Auth** | Public (no authentication required) |
| **Security schemes** | None declared |

**Header parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `user-agent` | `string` | no | — | User-Agent |

**Cookie parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `tor_session` | `string` *(nullable)* | no | — | Tor Session |

**Request body** — `application/json` (required)

Schema: [`RecordPopunderRequest`](#schema-recordpopunderrequest)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | `string` | **yes** | — | Name |
| `type` | `string` | no | default: `"popunder"` | Type |
| `record` | `boolean` | no | default: `true` | Record |

```json
{
  "name": "example",
  "type": "popunder",
  "record": true
}
```

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Successful Response | `application/json` → [`RecordPopunderResponse`](#schema-recordpopunderresponse) |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |

**Example request**

```bash
curl -X POST 'https://nhentai.net/api/v2/zones/h' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'user-agent: string' \
  -H 'Content-Type: application/json' \
  -d '{"name": "example", "type": "popunder", "record": true}'
```

**Example response** — `200`

```json
{
  "success": true
}
```

---

<a id="get-apiv2zonespu"></a>

#### `GET` `/api/v2/zones/pu`

**Popunder Redirect**

Redirect to popunder ad URL.

Two-step process:
1. First call (without out=1): records "opens" stat, redirects to self with out=1
2. Second call (with out=1): records "redirects" stat, redirects to actual URL

This allows tracking of both opens and actual redirects.

| | |
|---|---|
| **Operation ID** | `popunder_redirect_api_v2_zones_pu_get` |
| **Auth** | Public (no authentication required) |
| **Security schemes** | None declared |

**Query parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | `string` | **yes** | — | Name |
| `out` | `string` *(nullable)* | no | — | Out |

**Header parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `user-agent` | `string` | no | — | User-Agent |

**Cookie parameters**

| Name | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `tor_session` | `string` *(nullable)* | no | — | Tor Session |

**Responses**

| Code | Description | Body schema |
|---|---|---|
| `200` | Close window on error | `application/json` → `any`; `text/html` → `any` |
| `302` | Redirect to popunder URL | *(no body)* |
| `422` | Validation Error | `application/json` → [`HTTPValidationError`](#schema-httpvalidationerror) |

**Example request**

```bash
curl -X GET 'https://nhentai.net/api/v2/zones/pu?name=example' \
  -H 'User-Agent: ExampleApp/1.0 (https://example.com)' \
  -H 'user-agent: string'
```

---

## Schema reference

All 117 schema definitions, alphabetically. Types marked *(nullable)* accept `null`. "Required" reflects the schema's `required` array — for response objects it means the field is always present; for request objects it means you must supply it.

<a id="schema-announcement"></a>

### Announcement

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `message` | `string` | **yes** | — |  |
| `links` | array of [`AnnouncementLink`](#schema-announcementlink) | no | default: `[]` |  |

**Example**

```json
{
  "message": "Thanks for the upload!",
  "links": [
    {
      "text": "Thanks for the upload!",
      "url": "https://cdn.example.net/galleries/1451234/3.webp"
    }
  ]
}
```

---

<a id="schema-announcementlink"></a>

### AnnouncementLink

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `text` | `string` | **yes** | — |  |
| `url` | `string` | **yes** | — |  |

**Example**

```json
{
  "text": "Thanks for the upload!",
  "url": "https://cdn.example.net/galleries/1451234/3.webp"
}
```

---

<a id="schema-apikeycreateresponse"></a>

### ApiKeyCreateResponse

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `string` | **yes** | — |  |
| `key` | `string` | **yes** | — |  |
| `name` | `string` | **yes** | — |  |

**Example**

```json
{
  "id": "string",
  "key": "nh_live_7b1d9c3e5f8a4260b9d1c4e7f0a3b6d9",
  "name": "example"
}
```

*Used by:* `POST /api/v2/user/keys`

---

<a id="schema-apikeylistitem"></a>

### ApiKeyListItem

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `string` | **yes** | — |  |
| `key_prefix` | `string` | **yes** | — |  |
| `name` | `string` | **yes** | — |  |
| `created_at` | `integer` | **yes** | — |  |
| `last_used_at` | `integer` *(nullable)* | no | — |  |

**Example**

```json
{
  "id": "string",
  "key_prefix": "string",
  "name": "example",
  "created_at": 1778000000,
  "last_used_at": 1778000000
}
```

*Used by:* `GET /api/v2/user/keys`

---

<a id="schema-apirootresponse"></a>

### ApiRootResponse

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `version` | `string` | **yes** | — |  |
| `message` | `string` | **yes** | — |  |

**Example**

```json
{
  "version": "string",
  "message": "Thanks for the upload!"
}
```

*Used by:* `GET /api/v2`

---

<a id="schema-autocompleterequest"></a>

### AutocompleteRequest

Autocomplete request body.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `type` | `string` *(nullable)* | no | — |  |
| `query` | `string` *(nullable)* | no | — |  |
| `limit` | `integer` | no | min: `1.0`; max: `50.0`; default: `10` |  |

**Example**

```json
{
  "type": "tag",
  "query": "artist:example language:english",
  "limit": 10
}
```

*Used by:* `POST /api/v2/tags/search`

---

<a id="schema-backloggallery"></a>

### BacklogGallery

Gallery info attached to a backlog row.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `media_id` | `string` | **yes** | — |  |
| `thumbnail` | `string` | **yes** | — |  |
| `thumbnail_width` | `integer` | **yes** | — |  |
| `thumbnail_height` | `integer` | **yes** | — |  |
| `english_title` | `string` | **yes** | — |  |
| `japanese_title` | `string` *(nullable)* | no | — |  |
| `num_pages` | `integer` | **yes** | — |  |
| `num_favorites` | `integer` | **yes** | — |  |
| `upload_date` | `integer` | **yes** | — |  |
| `age_days` | `integer` | **yes** | — |  |
| `tags` | array of [`TagResponse`](#schema-tagresponse) | no | default: `[]` |  |

**Example**

```json
{
  "id": 2841902,
  "media_id": "2841902",
  "thumbnail": "/galleries/2841902/3.webp",
  "thumbnail_width": 1280,
  "thumbnail_height": 1807,
  "english_title": "Example Gallery Title",
  "japanese_title": "サンプルタイトル",
  "num_pages": 24,
  "num_favorites": 12,
  "upload_date": 1778000000,
  "age_days": 1,
  "tags": [
    {
      "id": 33814,
      "type": "tag",
      "name": "example",
      "slug": "example-slug",
      "url": "https://cdn.example.net/galleries/1451234/3.webp",
      "count": 12,
      "description": "A short human-readable description.",
      "is_community": false,
      "pending_describe_id": "string"
    }
  ]
}
```

---

<a id="schema-backloglistresponse"></a>

### BacklogListResponse

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `result` | array of [`BacklogRow`](#schema-backlogrow) | **yes** | — |  |
| `has_more` | `boolean` | no | default: `false` |  |
| `num_pages` | `integer` *(nullable)* | no | — |  |
| `total` | `integer` *(nullable)* | no | — |  |

**Example**

```json
{
  "result": [
    {
      "suggestion": {
        "id": "string",
        "gallery_id": 2841902,
        "tag": null,
        "action": "add",
        "status": "pending",
        "score": 5,
        "voter_count": 12,
        "proposer": null,
        "created_at": "2026-05-14T09:21:07Z",
        "resolved_at": "2026-05-14T09:21:07Z",
        "resolver": null,
        "resolution_note": "Reviewed and approved by staff.",
        "reverted_at": "2026-05-14T09:21:07Z",
        "reverter": null,
        "my_vote": 1,
        "tier": "trending"
      },
      "gallery": {
        "id": 2841902,
        "media_id": "2841902",
        "thumbnail": "/galleries/2841902/3.webp",
        "thumbnail_width": 1280,
        "thumbnail_height": 1807,
        "english_title": "Example Gallery Title",
        "japanese_title": "サンプルタイトル",
        "num_pages": 24,
        "num_favorites": 12,
        "upload_date": 1778000000,
        "age_days": 1,
        "tags": []
      }
    }
  ],
  "has_more": false,
  "num_pages": 24,
  "total": 1372
}
```

*Used by:* `GET /api/v2/gts/backlog`

---

<a id="schema-backlogrow"></a>

### BacklogRow

A pending tag-change suggestion plus the gallery it applies to.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `suggestion` | [`SuggestionResponse`](#schema-suggestionresponse) | **yes** | — |  |
| `gallery` | [`BacklogGallery`](#schema-backloggallery) | **yes** | — |  |

**Example**

```json
{
  "suggestion": {
    "id": "string",
    "gallery_id": 2841902,
    "tag": {
      "id": 1842,
      "type": "tag",
      "name": "example",
      "slug": "example-slug",
      "url": "https://cdn.example.net/galleries/1451234/3.webp",
      "description": "A short human-readable description."
    },
    "action": "add",
    "status": "pending",
    "score": 5,
    "voter_count": 12,
    "proposer": {
      "id": 90210,
      "username": "example_user",
      "slug": "example-slug",
      "avatar_url": "https://cdn.example.net/avatars/90210.png"
    },
    "created_at": "2026-05-14T09:21:07Z",
    "resolved_at": "2026-05-14T09:21:07Z",
    "resolver": {
      "id": 90210,
      "username": "example_user",
      "slug": "example-slug",
      "avatar_url": "https://cdn.example.net/avatars/90210.png"
    },
    "resolution_note": "Reviewed and approved by staff.",
    "reverted_at": "2026-05-14T09:21:07Z",
    "reverter": {
      "id": 90210,
      "username": "example_user",
      "slug": "example-slug",
      "avatar_url": "https://cdn.example.net/avatars/90210.png"
    },
    "my_vote": 1,
    "tier": "trending"
  },
  "gallery": {
    "id": 2841902,
    "media_id": "2841902",
    "thumbnail": "/galleries/2841902/3.webp",
    "thumbnail_width": 1280,
    "thumbnail_height": 1807,
    "english_title": "Example Gallery Title",
    "japanese_title": "サンプルタイトル",
    "num_pages": 24,
    "num_favorites": 12,
    "upload_date": 1778000000,
    "age_days": 1,
    "tags": [
      {
        "id": 33814,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "count": 12,
        "description": "A short human-readable description.",
        "is_community": false,
        "pending_describe_id": "string"
      }
    ]
  }
}
```

---

<a id="schema-blacklistlistresponse"></a>

### BlacklistListResponse

Response for listing blacklisted tags.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `tags` | array of [`BlacklistedTagResponse`](#schema-blacklistedtagresponse) | **yes** | — |  |
| `count` | `integer` | **yes** | — |  |

**Example**

```json
{
  "tags": [
    {
      "id": 33814,
      "type": "tag",
      "name": "example",
      "slug": "example-slug",
      "count": 12
    }
  ],
  "count": 12
}
```

*Used by:* `GET /api/v2/blacklist`

---

<a id="schema-blacklistresponse"></a>

### BlacklistResponse

Response for blacklist operations.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `success` | `boolean` | **yes** | — |  |
| `count` | `integer` | **yes** | — |  |

**Example**

```json
{
  "success": true,
  "count": 12
}
```

*Used by:* `POST /api/v2/blacklist`

---

<a id="schema-blacklistupdaterequest"></a>

### BlacklistUpdateRequest

Request body for updating blacklist.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `added` | array of `integer` | no | default: `[]` |  |
| `removed` | array of `integer` | no | default: `[]` |  |

**Example**

```json
{
  "added": [
    1
  ],
  "removed": [
    1
  ]
}
```

*Used by:* `POST /api/v2/blacklist`

---

<a id="schema-blacklistedtagresponse"></a>

### BlacklistedTagResponse

Blacklisted tag info.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `type` | `string` | **yes** | — |  |
| `name` | `string` | **yes** | — |  |
| `slug` | `string` | **yes** | — |  |
| `count` | `integer` | **yes** | — |  |

**Example**

```json
{
  "id": 33814,
  "type": "tag",
  "name": "example",
  "slug": "example-slug",
  "count": 12
}
```

---

<a id="schema-body-confirm-password-reset-api-v2-auth-reset-confirm-post"></a>

### Body_confirm_password_reset_api_v2_auth_reset_confirm_post

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `token` | `string` | **yes** | — | Reset token from the email link |
| `password` | `string` | **yes** | min length: `8` | New password |
| `pow_challenge` | `string` | **yes** | — | PoW challenge from GET /api/v2/pow. Empty string is fine when the action's difficulty is 0. |
| `pow_nonce` | `string` | **yes** | — | Nonce that solves the PoW challenge. Empty string is fine when the action's difficulty is 0. |
| `captcha_response` | `string` | **yes** | — | CAPTCHA response token from the widget |

**Example**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0NDIx",
  "password": "S3cur3-Passphrase!",
  "pow_challenge": "0f3a9c7e21b845d6",
  "pow_nonce": "000000000001a2f7",
  "captcha_response": "03AGdBq26k...captcha-token"
}
```

*Used by:* `POST /api/v2/auth/reset/confirm`

---

<a id="schema-body-create-api-key-api-v2-user-keys-post"></a>

### Body_create_api_key_api_v2_user_keys_post

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | `string` | **yes** | min length: `1`; max length: `255` |  |
| `purpose` | `string` | no | default: `""` |  |
| `pow_challenge` | `string` | **yes** | — | PoW challenge from GET /api/v2/pow. Empty string is fine when the action's difficulty is 0. |
| `pow_nonce` | `string` | **yes** | — | Nonce that solves the PoW challenge. Empty string is fine when the action's difficulty is 0. |
| `captcha_response` | `string` | **yes** | — | CAPTCHA response token from the widget |

**Example**

```json
{
  "name": "example",
  "purpose": "string",
  "pow_challenge": "0f3a9c7e21b845d6",
  "pow_nonce": "000000000001a2f7",
  "captcha_response": "03AGdBq26k...captcha-token"
}
```

*Used by:* `POST /api/v2/user/keys`

---

<a id="schema-body-create-comment-api-v2-galleries-gallery-id-comments-post"></a>

### Body_create_comment_api_v2_galleries__gallery_id__comments_post

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `body` | `string` | **yes** | min length: `10`; max length: `1000` | Comment text |
| `captcha_response` | `string` *(nullable)* | no | — | CAPTCHA response token |
| `pow_challenge` | `string` | **yes** | — | PoW challenge from GET /api/v2/pow. Empty string is fine when the action's difficulty is 0. |
| `pow_nonce` | `string` | **yes** | — | Nonce that solves the PoW challenge. Empty string is fine when the action's difficulty is 0. |

**Example**

```json
{
  "body": "Thanks for the upload!",
  "captcha_response": "03AGdBq26k...captcha-token",
  "pow_challenge": "0f3a9c7e21b845d6",
  "pow_nonce": "000000000001a2f7"
}
```

*Used by:* `POST /api/v2/galleries/{gallery_id}/comments`

---

<a id="schema-body-create-suggestion-api-v2-galleries-gallery-id-suggestions-post"></a>

### Body_create_suggestion_api_v2_galleries__gallery_id__suggestions_post

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `tag_id` | `integer` | **yes** | exclusive min: `0.0` |  |
| `action` | `string` enum | no | one of `"add"`, `"remove"`; default: `"add"` |  |
| `captcha_response` | `string` *(nullable)* | no | — | CAPTCHA response token |
| `pow_challenge` | `string` | **yes** | — | PoW challenge from GET /api/v2/pow. Empty string is fine when the action's difficulty is 0. |
| `pow_nonce` | `string` | **yes** | — | Nonce that solves the PoW challenge. Empty string is fine when the action's difficulty is 0. |

**Example**

```json
{
  "tag_id": 1234,
  "action": "add",
  "captcha_response": "03AGdBq26k...captcha-token",
  "pow_challenge": "0f3a9c7e21b845d6",
  "pow_nonce": "000000000001a2f7"
}
```

*Used by:* `POST /api/v2/galleries/{gallery_id}/suggestions`

---

<a id="schema-body-create-taxonomy-comment-api-v2-taxonomy-suggestion-id-comments-post"></a>

### Body_create_taxonomy_comment_api_v2_taxonomy__suggestion_id__comments_post

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `body` | `string` | **yes** | min length: `10`; max length: `1000` |  |
| `captcha_response` | `string` *(nullable)* | no | — | CAPTCHA response token |
| `pow_challenge` | `string` | **yes** | — | PoW challenge from GET /api/v2/pow. Empty string is fine when the action's difficulty is 0. |
| `pow_nonce` | `string` | **yes** | — | Nonce that solves the PoW challenge. Empty string is fine when the action's difficulty is 0. |

**Example**

```json
{
  "body": "Thanks for the upload!",
  "captcha_response": "03AGdBq26k...captcha-token",
  "pow_challenge": "0f3a9c7e21b845d6",
  "pow_nonce": "000000000001a2f7"
}
```

*Used by:* `POST /api/v2/taxonomy/{suggestion_id}/comments`

---

<a id="schema-body-create-taxonomy-suggestion-api-v2-taxonomy-post"></a>

### Body_create_taxonomy_suggestion_api_v2_taxonomy_post

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `action` | `string` enum | **yes** | one of `"create"`, `"rename"`, `"merge"`, `"describe"` |  |
| `target_tag_id` | `integer` *(nullable)* | no | exclusive min: `0.0` |  |
| `merge_into_tag_id` | `integer` *(nullable)* | no | exclusive min: `0.0` |  |
| `new_name` | `string` *(nullable)* | no | min length: `1`; max length: `100` |  |
| `new_type` | `string` enum *(nullable)* | no | one of `"tag"`, `"artist"`, `"parody"`, `"character"`, `"group"`, `"language"`, `"category"` |  |
| `new_description` | `string` *(nullable)* | no | min length: `1`; max length: `2000` |  |
| `proposer_note` | `string` *(nullable)* | no | max length: `500` |  |
| `captcha_response` | `string` *(nullable)* | no | — | CAPTCHA response token |
| `pow_challenge` | `string` | **yes** | — | PoW challenge from GET /api/v2/pow. Empty string is fine when the action's difficulty is 0. |
| `pow_nonce` | `string` | **yes** | — | Nonce that solves the PoW challenge. Empty string is fine when the action's difficulty is 0. |

**Example**

```json
{
  "action": "create",
  "target_tag_id": 1234,
  "merge_into_tag_id": 1234,
  "new_name": "example",
  "new_type": "tag",
  "new_description": "A short human-readable description.",
  "proposer_note": "Reviewed and approved by staff.",
  "captcha_response": "03AGdBq26k...captcha-token",
  "pow_challenge": "0f3a9c7e21b845d6",
  "pow_nonce": "000000000001a2f7"
}
```

*Used by:* `POST /api/v2/taxonomy`

---

<a id="schema-body-edit-taxonomy-suggestion-api-v2-taxonomy-suggestion-id-patch"></a>

### Body_edit_taxonomy_suggestion_api_v2_taxonomy__suggestion_id__patch

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `action` | `string` enum | **yes** | one of `"create"`, `"rename"`, `"merge"`, `"describe"` |  |
| `target_tag_id` | `integer` *(nullable)* | no | exclusive min: `0.0` |  |
| `merge_into_tag_id` | `integer` *(nullable)* | no | exclusive min: `0.0` |  |
| `new_name` | `string` *(nullable)* | no | min length: `1`; max length: `100` |  |
| `new_type` | `string` enum *(nullable)* | no | one of `"tag"`, `"artist"`, `"parody"`, `"character"`, `"group"`, `"language"`, `"category"` |  |
| `new_description` | `string` *(nullable)* | no | min length: `1`; max length: `2000` |  |
| `proposer_note` | `string` *(nullable)* | no | max length: `500` |  |
| `summary` | `string` *(nullable)* | no | max length: `500` |  |

**Example**

```json
{
  "action": "create",
  "target_tag_id": 1234,
  "merge_into_tag_id": 1234,
  "new_name": "example",
  "new_type": "tag",
  "new_description": "A short human-readable description.",
  "proposer_note": "Reviewed and approved by staff.",
  "summary": "string"
}
```

*Used by:* `PATCH /api/v2/taxonomy/{suggestion_id}`

---

<a id="schema-body-login-api-v2-auth-login-post"></a>

### Body_login_api_v2_auth_login_post

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `username` | `string` | **yes** | — | Username or email |
| `password` | `string` | **yes** | — |  |
| `pow_challenge` | `string` | **yes** | — | PoW challenge from GET /api/v2/pow. Empty string is fine when the action's difficulty is 0. |
| `pow_nonce` | `string` | **yes** | — | Nonce that solves the PoW challenge. Empty string is fine when the action's difficulty is 0. |
| `captcha_response` | `string` | **yes** | — | CAPTCHA response token from the widget |

**Example**

```json
{
  "username": "example_user",
  "password": "S3cur3-Passphrase!",
  "pow_challenge": "0f3a9c7e21b845d6",
  "pow_nonce": "000000000001a2f7",
  "captcha_response": "03AGdBq26k...captcha-token"
}
```

*Used by:* `POST /api/v2/auth/login`

---

<a id="schema-body-logout-api-v2-auth-logout-post"></a>

### Body_logout_api_v2_auth_logout_post

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `refresh_token` | `string` | **yes** | — | Refresh token to revoke |

**Example**

```json
{
  "refresh_token": "rt_9f2c4b1ae7d34c8fb0a1e5d6c7b8a9f0"
}
```

*Used by:* `POST /api/v2/auth/logout`

---

<a id="schema-body-refresh-api-v2-auth-refresh-post"></a>

### Body_refresh_api_v2_auth_refresh_post

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `refresh_token` | `string` | **yes** | — | Refresh token to exchange |

**Example**

```json
{
  "refresh_token": "rt_9f2c4b1ae7d34c8fb0a1e5d6c7b8a9f0"
}
```

*Used by:* `POST /api/v2/auth/refresh`

---

<a id="schema-body-register-api-v2-auth-register-post"></a>

### Body_register_api_v2_auth_register_post

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `username` | `string` | **yes** | min length: `3`; max length: `30` |  |
| `email` | `string` | **yes** | — |  |
| `password` | `string` | **yes** | min length: `8` |  |
| `pow_challenge` | `string` | **yes** | — | PoW challenge from GET /api/v2/pow. Empty string is fine when the action's difficulty is 0. |
| `pow_nonce` | `string` | **yes** | — | Nonce that solves the PoW challenge. Empty string is fine when the action's difficulty is 0. |
| `captcha_response` | `string` | **yes** | — | CAPTCHA response token from the widget |

**Example**

```json
{
  "username": "example_user",
  "email": "user@example.com",
  "password": "S3cur3-Passphrase!",
  "pow_challenge": "0f3a9c7e21b845d6",
  "pow_nonce": "000000000001a2f7",
  "captcha_response": "03AGdBq26k...captcha-token"
}
```

*Used by:* `POST /api/v2/auth/register`

---

<a id="schema-body-request-password-reset-api-v2-auth-reset-post"></a>

### Body_request_password_reset_api_v2_auth_reset_post

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `username_or_email` | `string` | **yes** | — | Username or email address |
| `pow_challenge` | `string` | **yes** | — | PoW challenge from GET /api/v2/pow. Empty string is fine when the action's difficulty is 0. |
| `pow_nonce` | `string` | **yes** | — | Nonce that solves the PoW challenge. Empty string is fine when the action's difficulty is 0. |
| `captcha_response` | `string` | **yes** | — | CAPTCHA response token from the widget |

**Example**

```json
{
  "username_or_email": "user@example.com",
  "pow_challenge": "0f3a9c7e21b845d6",
  "pow_nonce": "000000000001a2f7",
  "captcha_response": "03AGdBq26k...captcha-token"
}
```

*Used by:* `POST /api/v2/auth/reset`

---

<a id="schema-body-update-spam-config-api-v2-moderation-spam-config-name-put"></a>

### Body_update_spam_config_api_v2_moderation_spam_config__name__put

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `items` | array of `string` | **yes** | — |  |

**Example**

```json
{
  "items": [
    "string"
  ]
}
```

*Used by:* `PUT /api/v2/moderation/spam/config/{name}`

---

<a id="schema-body-upload-avatar-api-v2-user-avatar-post"></a>

### Body_upload_avatar_api_v2_user_avatar_post

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `avatar` | `string` (`binary`) | **yes** | format: `binary` |  |

**Example**

```json
{
  "avatar": "<binary file data>"
}
```

*Used by:* `POST /api/v2/user/avatar`

---

<a id="schema-body-vote-on-suggestion-api-v2-galleries-gallery-id-suggestions-suggestion-id-vote-post"></a>

### Body_vote_on_suggestion_api_v2_galleries__gallery_id__suggestions__suggestion_id__vote_post

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `vote` | `integer` | **yes** | min: `-1.0`; max: `1.0` |  |
| `pow_challenge` | `string` | **yes** | — | PoW challenge from GET /api/v2/pow. Empty string is fine when the action's difficulty is 0. |
| `pow_nonce` | `string` | **yes** | — | Nonce that solves the PoW challenge. Empty string is fine when the action's difficulty is 0. |

**Example**

```json
{
  "vote": -1.0,
  "pow_challenge": "0f3a9c7e21b845d6",
  "pow_nonce": "000000000001a2f7"
}
```

*Used by:* `POST /api/v2/galleries/{gallery_id}/suggestions/{suggestion_id}/vote`

---

<a id="schema-body-vote-on-taxonomy-suggestion-api-v2-taxonomy-suggestion-id-vote-post"></a>

### Body_vote_on_taxonomy_suggestion_api_v2_taxonomy__suggestion_id__vote_post

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `vote` | `integer` | **yes** | min: `-1.0`; max: `1.0` |  |
| `pow_challenge` | `string` | **yes** | — | PoW challenge from GET /api/v2/pow. Empty string is fine when the action's difficulty is 0. |
| `pow_nonce` | `string` | **yes** | — | Nonce that solves the PoW challenge. Empty string is fine when the action's difficulty is 0. |

**Example**

```json
{
  "vote": -1.0,
  "pow_challenge": "0f3a9c7e21b845d6",
  "pow_nonce": "000000000001a2f7"
}
```

*Used by:* `POST /api/v2/taxonomy/{suggestion_id}/vote`

---

<a id="schema-captchaerrorresponse"></a>

### CaptchaErrorResponse

Error response when CAPTCHA verification fails.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `error` | `string` | **yes** | — |  |
| `captcha_required` | `boolean` | no | default: `true` |  |
| `captcha_public_key` | `string` | **yes** | — |  |

**Example**

```json
{
  "error": "string",
  "captcha_required": true,
  "captcha_public_key": "03AGdBq26k...captcha-token"
}
```

*Used by:* `POST /api/v2/galleries/{gallery_id}/comments`, `POST /api/v2/galleries/{gallery_id}/suggestions`, `POST /api/v2/taxonomy/{suggestion_id}/comments`, `POST /api/v2/taxonomy`

---

<a id="schema-captchainforesponse"></a>

### CaptchaInfoResponse

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `provider` | `string` | **yes** | — |  |
| `site_key` | `string` | **yes** | — |  |

**Example**

```json
{
  "provider": "string",
  "site_key": "string"
}
```

*Used by:* `GET /api/v2/captcha`

---

<a id="schema-cdnconfigresponse"></a>

### CdnConfigResponse

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `image_servers` | array of `string` | **yes** | — |  |
| `thumb_servers` | array of `string` | **yes** | — |  |

**Example**

```json
{
  "image_servers": [
    "string"
  ],
  "thumb_servers": [
    "string"
  ]
}
```

*Used by:* `GET /api/v2/cdn`

---

<a id="schema-commentresponse"></a>

### CommentResponse

Comment response matching Django format.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `gallery_id` | `integer` | **yes** | — |  |
| `poster` | [`UserPublic`](#schema-userpublic) | **yes** | — |  |
| `post_date` | `integer` | **yes** | — |  |
| `body` | `string` | **yes** | — |  |

**Example**

```json
{
  "id": 4410927,
  "gallery_id": 2841902,
  "poster": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png",
    "is_superuser": false,
    "is_staff": false
  },
  "post_date": 1778000000,
  "body": "Thanks for the upload!"
}
```

*Used by:* `POST /api/v2/galleries/{gallery_id}/comments`

---

<a id="schema-configresponse"></a>

### ConfigResponse

Combined config: CDN servers + announcement.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `image_servers` | array of `string` | **yes** | — |  |
| `thumb_servers` | array of `string` | **yes** | — |  |
| `announcement` | [`Announcement`](#schema-announcement) *(nullable)* | no | — |  |

**Example**

```json
{
  "image_servers": [
    "string"
  ],
  "thumb_servers": [
    "string"
  ],
  "announcement": {
    "message": "Thanks for the upload!",
    "links": [
      {
        "text": "Thanks for the upload!",
        "url": "https://cdn.example.net/galleries/1451234/3.webp"
      }
    ]
  }
}
```

*Used by:* `GET /api/v2/config`

---

<a id="schema-coverinfo"></a>

### CoverInfo

Cover/thumbnail image with path and dimensions.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `path` | `string` | **yes** | — |  |
| `width` | `integer` | **yes** | — |  |
| `height` | `integer` | **yes** | — |  |

**Example**

```json
{
  "path": "/galleries/2841902/3.webp",
  "width": 1280,
  "height": 1807
}
```

---

<a id="schema-createtagrequest"></a>

### CreateTagRequest

Mod-only request to mint a brand-new tag.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `type` | `string` enum | **yes** | one of `"tag"`, `"artist"`, `"parody"`, `"character"`, `"group"`, `"language"`, `"category"` |  |
| `name` | `string` | **yes** | min length: `1`; max length: `100` |  |

**Example**

```json
{
  "type": "tag",
  "name": "example"
}
```

*Used by:* `POST /api/v2/moderation/tags`

---

<a id="schema-createdtag"></a>

### CreatedTag

Tag to be created as part of an edit.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `type` | `string` | **yes** | — |  |
| `name` | `string` | **yes** | — |  |

**Example**

```json
{
  "type": "tag",
  "name": "example"
}
```

---

<a id="schema-createdtagresponse"></a>

### CreatedTagResponse

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `type` | `string` | **yes** | — |  |
| `name` | `string` | **yes** | — |  |
| `slug` | `string` | **yes** | — |  |
| `url` | `string` | **yes** | — |  |

**Example**

```json
{
  "id": 33814,
  "type": "tag",
  "name": "example",
  "slug": "example-slug",
  "url": "https://cdn.example.net/galleries/1451234/3.webp"
}
```

*Used by:* `POST /api/v2/moderation/tags`

---

<a id="schema-creativeslot"></a>

### CreativeSlot

House-creative slot: API names a creative the web knows how to render
(e.g. "kurohebi"). Web picks its own component + layout; `params` lets
the API hint variants without renegotiating the schema.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `type` | `string` | no | default: `"creative"` |  |
| `name` | `string` | **yes** | — |  |
| `params` | `object` | no | — |  |

**Example**

```json
{
  "type": "creative",
  "name": "example",
  "params": {}
}
```

---

<a id="schema-deleteprofilerequest"></a>

### DeleteProfileRequest

Request body for deleting user profile.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `password` | `string` | **yes** | — |  |
| `confirmation` | `string` | **yes** | — |  |

**Example**

```json
{
  "password": "S3cur3-Passphrase!",
  "confirmation": "string"
}
```

*Used by:* `DELETE /api/v2/user`

---

<a id="schema-deleteprofileresponse"></a>

### DeleteProfileResponse

Response for profile deletion.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `success` | `boolean` | **yes** | — |  |
| `message` | `string` | **yes** | — |  |

**Example**

```json
{
  "success": true,
  "message": "Thanks for the upload!"
}
```

*Used by:* `DELETE /api/v2/user`

---

<a id="schema-downloadresponse"></a>

### DownloadResponse

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `url` | `string` | **yes** | — |  |
| `expires_at` | `integer` | **yes** | — |  |

**Example**

```json
{
  "url": "https://cdn.example.net/galleries/1451234/3.webp",
  "expires_at": 1778000900
}
```

*Used by:* `POST /api/v2/galleries/{gallery_id}/download`

---

<a id="schema-editlistresponse"></a>

### EditListResponse

Response for listing edits.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `edits` | array of [`EditResponse`](#schema-editresponse) | **yes** | — |  |
| `count` | `integer` | **yes** | — |  |

**Example**

```json
{
  "edits": [
    {
      "id": 1842,
      "user_id": 90210,
      "user_username": "example_user",
      "gallery_id": 2841902,
      "gallery_title": "example",
      "date": 1778000000,
      "accepted": false,
      "added_tags": [
        {
          "id": 1842,
          "type": "tag",
          "name": "example",
          "slug": "example-slug",
          "count": 12,
          "action": "login"
        }
      ],
      "removed_tags": [
        {
          "id": 1842,
          "type": "tag",
          "name": "example",
          "slug": "example-slug",
          "count": 12,
          "action": "login"
        }
      ],
      "created_tags": [
        {
          "type": "tag",
          "name": "example"
        }
      ],
      "upvotes": 5,
      "downvotes": 5,
      "user_vote": false
    }
  ],
  "count": 12
}
```

*Used by:* `GET /api/v2/moderation/edits`

---

<a id="schema-editresponse"></a>

### EditResponse

Single edit response.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `user_id` | `integer` *(nullable)* | **yes** | — |  |
| `user_username` | `string` *(nullable)* | **yes** | — |  |
| `gallery_id` | `integer` | **yes** | — |  |
| `gallery_title` | `string` *(nullable)* | **yes** | — |  |
| `date` | `integer` | **yes** | — |  |
| `accepted` | `boolean` *(nullable)* | **yes** | — |  |
| `added_tags` | array of [`EditTagInfo`](#schema-edittaginfo) | **yes** | — |  |
| `removed_tags` | array of [`EditTagInfo`](#schema-edittaginfo) | **yes** | — |  |
| `created_tags` | array of [`CreatedTag`](#schema-createdtag) | **yes** | — |  |
| `upvotes` | `integer` | no | default: `0` |  |
| `downvotes` | `integer` | no | default: `0` |  |
| `user_vote` | `boolean` *(nullable)* | no | — |  |

**Example**

```json
{
  "id": 1842,
  "user_id": 90210,
  "user_username": "example_user",
  "gallery_id": 2841902,
  "gallery_title": "example",
  "date": 1778000000,
  "accepted": false,
  "added_tags": [
    {
      "id": 1842,
      "type": "tag",
      "name": "example",
      "slug": "example-slug",
      "count": 12,
      "action": "login"
    }
  ],
  "removed_tags": [
    {
      "id": 1842,
      "type": "tag",
      "name": "example",
      "slug": "example-slug",
      "count": 12,
      "action": "login"
    }
  ],
  "created_tags": [
    {
      "type": "tag",
      "name": "example"
    }
  ],
  "upvotes": 5,
  "downvotes": 5,
  "user_vote": false
}
```

*Used by:* `GET /api/v2/moderation/edits/{edit_id}`

---

<a id="schema-edittaginfo"></a>

### EditTagInfo

Tag info for edit display.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `type` | `string` | **yes** | — |  |
| `name` | `string` | **yes** | — |  |
| `slug` | `string` | **yes** | — |  |
| `count` | `integer` | **yes** | — |  |
| `action` | `string` | **yes** | — |  |

**Example**

```json
{
  "id": 1842,
  "type": "tag",
  "name": "example",
  "slug": "example-slug",
  "count": 12,
  "action": "login"
}
```

---

<a id="schema-errorresponse"></a>

### ErrorResponse

Error response.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `error` | `string` | **yes** | — |  |

**Example**

```json
{
  "error": "string"
}
```

*Used by:* `DELETE /api/v2/auth/sessions/{session_id}`, `DELETE /api/v2/comments/{comment_id}`, `DELETE /api/v2/galleries/{gallery_id}/favorite`, `DELETE /api/v2/galleries/{gallery_id}/suggestions/{suggestion_id}`, `DELETE /api/v2/moderation/api-keys/{key_id}`, `DELETE /api/v2/moderation/comments/{comment_id}/hide`, `DELETE /api/v2/moderation/galleries/{gallery_id}/hidden`, `DELETE /api/v2/moderation/taxonomy/{suggestion_id}` *(+87 more)*

---

<a id="schema-favoriteresponse"></a>

### FavoriteResponse

Response for favorite/unfavorite actions.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `favorited` | `boolean` | **yes** | — |  |
| `num_favorites` | `integer` *(nullable)* | no | — |  |

**Example**

```json
{
  "favorited": false,
  "num_favorites": 12
}
```

*Used by:* `DELETE /api/v2/galleries/{gallery_id}/favorite`, `GET /api/v2/galleries/{gallery_id}/favorite`, `POST /api/v2/galleries/{gallery_id}/favorite`

---

<a id="schema-flagcommentrequest"></a>

### FlagCommentRequest

Request body for flagging a comment.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `reason` | `string` | **yes** | min length: `1`; max length: `500` |  |

**Example**

```json
{
  "reason": "Duplicate of an existing entry"
}
```

*Used by:* `POST /api/v2/comments/{comment_id}/flag`

---

<a id="schema-gallerydetailresponse"></a>

### GalleryDetailResponse

Gallery detail with optional included data (comments, related, favorite, suggestions).

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `media_id` | `string` | **yes** | — |  |
| `title` | [`GalleryTitle`](#schema-gallerytitle) | **yes** | — |  |
| `cover` | [`CoverInfo`](#schema-coverinfo) | **yes** | — |  |
| `thumbnail` | [`CoverInfo`](#schema-coverinfo) | **yes** | — |  |
| `scanlator` | `string` | no | default: `""` |  |
| `upload_date` | `integer` | **yes** | — |  |
| `tags` | array of [`TagResponse`](#schema-tagresponse) | **yes** | — |  |
| `num_pages` | `integer` | **yes** | — |  |
| `num_favorites` | `integer` | **yes** | — |  |
| `pages` | array of [`PageInfo`](#schema-pageinfo) | no | default: `[]` |  |
| `comments` | array of [`CommentResponse`](#schema-commentresponse) *(nullable)* | no | — |  |
| `comment_count` | `integer` *(nullable)* | no | — |  |
| `related` | array of [`GalleryListItem`](#schema-gallerylistitem) *(nullable)* | no | — |  |
| `is_favorited` | `boolean` *(nullable)* | no | — |  |
| `suggestions` | [`GallerySuggestionsBundle`](#schema-gallerysuggestionsbundle) *(nullable)* | no | — |  |

**Example**

```json
{
  "id": 2841902,
  "media_id": "2841902",
  "title": {
    "english": "Example Gallery Title",
    "japanese": "サンプルタイトル",
    "pretty": "Example Gallery Title"
  },
  "cover": {
    "path": "/galleries/2841902/3.webp",
    "width": 1280,
    "height": 1807
  },
  "thumbnail": {
    "path": "/galleries/2841902/3.webp",
    "width": 1280,
    "height": 1807
  },
  "scanlator": "string",
  "upload_date": 1778000000,
  "tags": [
    {
      "id": 33814,
      "type": "tag",
      "name": "example",
      "slug": "example-slug",
      "url": "https://cdn.example.net/galleries/1451234/3.webp",
      "count": 12,
      "description": "A short human-readable description.",
      "is_community": false,
      "pending_describe_id": "string"
    }
  ],
  "num_pages": 24,
  "num_favorites": 12,
  "pages": [
    {
      "number": 1,
      "path": "/galleries/2841902/3.webp",
      "width": 1280,
      "height": 1807,
      "thumbnail": "/galleries/2841902/3.webp",
      "thumbnail_width": 1280,
      "thumbnail_height": 1807
    }
  ],
  "comments": [
    {
      "id": 4410927,
      "gallery_id": 2841902,
      "poster": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png",
        "is_superuser": false,
        "is_staff": false
      },
      "post_date": 1778000000,
      "body": "Thanks for the upload!"
    }
  ],
  "comment_count": 12,
  "related": [
    {
      "id": 2841902,
      "media_id": "2841902",
      "english_title": "Example Gallery Title",
      "japanese_title": "サンプルタイトル",
      "thumbnail": "/galleries/2841902/3.webp",
      "thumbnail_width": 1280,
      "thumbnail_height": 1807,
      "num_pages": 24,
      "num_favorites": 12,
      "tag_ids": [],
      "blacklisted": false
    }
  ],
  "is_favorited": false,
  "suggestions": {
    "trending": [
      {
        "id": "string",
        "gallery_id": 2841902,
        "tag": null,
        "action": "add",
        "status": "pending",
        "score": 5,
        "voter_count": 12,
        "proposer": null,
        "created_at": "2026-05-14T09:21:07Z",
        "resolved_at": "2026-05-14T09:21:07Z",
        "resolver": null,
        "resolution_note": "Reviewed and approved by staff.",
        "reverted_at": "2026-05-14T09:21:07Z",
        "reverter": null,
        "my_vote": 1,
        "tier": "trending"
      }
    ],
    "active": [
      {
        "id": "string",
        "gallery_id": 2841902,
        "tag": null,
        "action": "add",
        "status": "pending",
        "score": 5,
        "voter_count": 12,
        "proposer": null,
        "created_at": "2026-05-14T09:21:07Z",
        "resolved_at": "2026-05-14T09:21:07Z",
        "resolver": null,
        "resolution_note": "Reviewed and approved by staff.",
        "reverted_at": "2026-05-14T09:21:07Z",
        "reverter": null,
        "my_vote": 1,
        "tier": "trending"
      }
    ],
    "mine": [
      {
        "id": "string",
        "gallery_id": 2841902,
        "tag": null,
        "action": "add",
        "status": "pending",
        "score": 5,
        "voter_count": 12,
        "proposer": null,
        "created_at": "2026-05-14T09:21:07Z",
        "resolved_at": "2026-05-14T09:21:07Z",
        "resolver": null,
        "resolution_note": "Reviewed and approved by staff.",
        "reverted_at": "2026-05-14T09:21:07Z",
        "reverter": null,
        "my_vote": 1,
        "tier": "trending"
      }
    ],
    "counts": {
      "trending": 1,
      "active": 1,
      "declined": 1,
      "hidden": 1
    }
  }
}
```

*Used by:* `GET /api/v2/galleries/{gallery_id}`

---

<a id="schema-gallerylinkpreview"></a>

### GalleryLinkPreview

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `start` | `integer` | **yes** | — |  |
| `end` | `integer` | **yes** | — |  |
| `matched` | `string` | **yes** | — |  |
| `kind` | `string` | no | default: `"gallery"` |  |
| `gallery` | [`GalleryListItem`](#schema-gallerylistitem) | **yes** | — |  |

**Example**

```json
{
  "start": 1,
  "end": 1,
  "matched": "string",
  "kind": "gallery",
  "gallery": {
    "id": 2841902,
    "media_id": "2841902",
    "english_title": "Example Gallery Title",
    "japanese_title": "サンプルタイトル",
    "thumbnail": "/galleries/2841902/3.webp",
    "thumbnail_width": 1280,
    "thumbnail_height": 1807,
    "num_pages": 24,
    "num_favorites": 12,
    "tag_ids": [
      1234
    ],
    "blacklisted": false
  }
}
```

---

<a id="schema-gallerylistitem"></a>

### GalleryListItem

Lightweight gallery for list views.
Used in search results, tag listings, homepage.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `media_id` | `string` | **yes** | — |  |
| `english_title` | `string` | **yes** | — |  |
| `japanese_title` | `string` *(nullable)* | no | — |  |
| `thumbnail` | `string` | **yes** | — |  |
| `thumbnail_width` | `integer` | **yes** | — |  |
| `thumbnail_height` | `integer` | **yes** | — |  |
| `num_pages` | `integer` | no | default: `0` |  |
| `num_favorites` | `integer` | no | default: `0` |  |
| `tag_ids` | array of `integer` | no | default: `[]` |  |
| `blacklisted` | `boolean` | no | default: `false` |  |

**Example**

```json
{
  "id": 2841902,
  "media_id": "2841902",
  "english_title": "Example Gallery Title",
  "japanese_title": "サンプルタイトル",
  "thumbnail": "/galleries/2841902/3.webp",
  "thumbnail_width": 1280,
  "thumbnail_height": 1807,
  "num_pages": 24,
  "num_favorites": 12,
  "tag_ids": [
    1234
  ],
  "blacklisted": false
}
```

*Used by:* `GET /api/v2/galleries/popular`

---

<a id="schema-gallerysuggestionsbundle"></a>

### GallerySuggestionsBundle

Gallery-detail include payload. Trending head + small active head + counts.

`mine` carries the authenticated viewer's own pending suggestions on this
gallery (regardless of which classifier tier they live in). Empty for anon
viewers. Bounded by the per-user-per-gallery quota.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `trending` | array of [`SuggestionResponse`](#schema-suggestionresponse) | **yes** | — |  |
| `active` | array of [`SuggestionResponse`](#schema-suggestionresponse) | **yes** | — |  |
| `mine` | array of [`SuggestionResponse`](#schema-suggestionresponse) | no | default: `[]` |  |
| `counts` | [`SuggestionTierCounts`](#schema-suggestiontiercounts) | **yes** | — |  |

**Example**

```json
{
  "trending": [
    {
      "id": "string",
      "gallery_id": 2841902,
      "tag": {
        "id": 1842,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "description": "A short human-readable description."
      },
      "action": "add",
      "status": "pending",
      "score": 5,
      "voter_count": 12,
      "proposer": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "created_at": "2026-05-14T09:21:07Z",
      "resolved_at": "2026-05-14T09:21:07Z",
      "resolver": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "resolution_note": "Reviewed and approved by staff.",
      "reverted_at": "2026-05-14T09:21:07Z",
      "reverter": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "my_vote": 1,
      "tier": "trending"
    }
  ],
  "active": [
    {
      "id": "string",
      "gallery_id": 2841902,
      "tag": {
        "id": 1842,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "description": "A short human-readable description."
      },
      "action": "add",
      "status": "pending",
      "score": 5,
      "voter_count": 12,
      "proposer": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "created_at": "2026-05-14T09:21:07Z",
      "resolved_at": "2026-05-14T09:21:07Z",
      "resolver": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "resolution_note": "Reviewed and approved by staff.",
      "reverted_at": "2026-05-14T09:21:07Z",
      "reverter": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "my_vote": 1,
      "tier": "trending"
    }
  ],
  "mine": [
    {
      "id": "string",
      "gallery_id": 2841902,
      "tag": {
        "id": 1842,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "description": "A short human-readable description."
      },
      "action": "add",
      "status": "pending",
      "score": 5,
      "voter_count": 12,
      "proposer": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "created_at": "2026-05-14T09:21:07Z",
      "resolved_at": "2026-05-14T09:21:07Z",
      "resolver": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "resolution_note": "Reviewed and approved by staff.",
      "reverted_at": "2026-05-14T09:21:07Z",
      "reverter": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "my_vote": 1,
      "tier": "trending"
    }
  ],
  "counts": {
    "trending": 1,
    "active": 1,
    "declined": 1,
    "hidden": 1
  }
}
```

---

<a id="schema-gallerytitle"></a>

### GalleryTitle

Gallery title in multiple languages.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `english` | `string` | **yes** | — |  |
| `japanese` | `string` *(nullable)* | no | — |  |
| `pretty` | `string` | **yes** | — |  |

**Example**

```json
{
  "english": "Example Gallery Title",
  "japanese": "サンプルタイトル",
  "pretty": "Example Gallery Title"
}
```

---

<a id="schema-httpvalidationerror"></a>

### HTTPValidationError

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `detail` | array of [`ValidationError`](#schema-validationerror) | no | — |  |

**Example**

```json
{
  "detail": [
    {
      "loc": [
        "string"
      ],
      "msg": "string",
      "type": "tag",
      "input": "string",
      "ctx": {}
    }
  ]
}
```

*Used by:* `DELETE /api/v2/auth/sessions/{session_id}`, `DELETE /api/v2/comments/{comment_id}`, `DELETE /api/v2/galleries/{gallery_id}/favorite`, `DELETE /api/v2/galleries/{gallery_id}/suggestions/{suggestion_id}`, `DELETE /api/v2/moderation/api-keys/{key_id}`, `DELETE /api/v2/moderation/comments/{comment_id}/hide`, `DELETE /api/v2/moderation/galleries/{gallery_id}/hidden`, `DELETE /api/v2/moderation/taxonomy/{suggestion_id}` *(+83 more)*

---

<a id="schema-hiddengalleryresponse"></a>

### HiddenGalleryResponse

Response for gallery hide/unhide actions.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `hidden` | `boolean` | **yes** | — |  |

**Example**

```json
{
  "id": 2841902,
  "hidden": false
}
```

*Used by:* `DELETE /api/v2/moderation/galleries/{gallery_id}/hidden`, `PUT /api/v2/moderation/galleries/{gallery_id}/hidden`

---

<a id="schema-htmlslot"></a>

### HtmlSlot

Paid-inventory slot: API hands the web pre-rendered HTML to inject.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `type` | `string` | no | default: `"html"` |  |
| `html` | `string` | **yes** | — |  |

**Example**

```json
{
  "type": "html",
  "html": "<div id=\"ad-slot\"></div>"
}
```

---

<a id="schema-moderationapikeyitem"></a>

### ModerationApiKeyItem

A single API key with its owner info (admin view).

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `string` | **yes** | — |  |
| `key_prefix` | `string` | **yes** | — |  |
| `name` | `string` *(nullable)* | **yes** | — |  |
| `purpose` | `string` *(nullable)* | **yes** | — |  |
| `scopes` | array of `string` *(nullable)* | **yes** | — |  |
| `created_at` | `string` | **yes** | — |  |
| `last_used_at` | `string` *(nullable)* | **yes** | — |  |
| `user_id` | `integer` | **yes** | — |  |
| `username` | `string` | **yes** | — |  |
| `user_slug` | `string` | **yes** | — |  |

**Example**

```json
{
  "id": "string",
  "key_prefix": "string",
  "name": "example",
  "purpose": "string",
  "scopes": [
    "string"
  ],
  "created_at": "string",
  "last_used_at": "string",
  "user_id": 90210,
  "username": "example_user",
  "user_slug": "example-slug"
}
```

---

<a id="schema-moderationapikeyslistresponse"></a>

### ModerationApiKeysListResponse

Paginated list of API keys for admin.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `keys` | array of [`ModerationApiKeyItem`](#schema-moderationapikeyitem) | **yes** | — |  |
| `total` | `integer` | **yes** | — |  |
| `page` | `integer` | **yes** | — |  |
| `per_page` | `integer` | **yes** | — |  |
| `num_pages` | `integer` | **yes** | — |  |

**Example**

```json
{
  "keys": [
    {
      "id": "string",
      "key_prefix": "string",
      "name": "example",
      "purpose": "string",
      "scopes": [],
      "created_at": "string",
      "last_used_at": "string",
      "user_id": 90210,
      "username": "example_user",
      "user_slug": "example-slug"
    }
  ],
  "total": 1372,
  "page": 1,
  "per_page": 25,
  "num_pages": 24
}
```

*Used by:* `GET /api/v2/moderation/api-keys`

---

<a id="schema-moderationcommentresponse"></a>

### ModerationCommentResponse

Comment info for moderation views.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `gallery_id` | `integer` | **yes** | — |  |
| `gallery_title` | `string` *(nullable)* | **yes** | — |  |
| `poster_id` | `integer` | **yes** | — |  |
| `poster_username` | `string` | **yes** | — |  |
| `poster_slug` | `string` | **yes** | — |  |
| `poster_avatar` | `string` | **yes** | — |  |
| `poster_is_shadowbanned` | `boolean` | **yes** | — |  |
| `body` | `string` | **yes** | — |  |
| `post_date` | `integer` | **yes** | — |  |
| `is_hidden` | `boolean` | **yes** | — |  |

**Example**

```json
{
  "id": 4410927,
  "gallery_id": 2841902,
  "gallery_title": "example",
  "poster_id": 1234,
  "poster_username": "example_user",
  "poster_slug": "example-slug",
  "poster_avatar": "https://cdn.example.net/avatars/90210.png",
  "poster_is_shadowbanned": false,
  "body": "Thanks for the upload!",
  "post_date": 1778000000,
  "is_hidden": false
}
```

---

<a id="schema-moderationcommentslistresponse"></a>

### ModerationCommentsListResponse

Response for moderation comment lists.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `comments` | array of [`ModerationCommentResponse`](#schema-moderationcommentresponse) | **yes** | — |  |
| `total` | `integer` | **yes** | — |  |
| `page` | `integer` | **yes** | — |  |
| `per_page` | `integer` | **yes** | — |  |
| `num_pages` | `integer` | **yes** | — |  |

**Example**

```json
{
  "comments": [
    {
      "id": 4410927,
      "gallery_id": 2841902,
      "gallery_title": "example",
      "poster_id": 1234,
      "poster_username": "example_user",
      "poster_slug": "example-slug",
      "poster_avatar": "https://cdn.example.net/avatars/90210.png",
      "poster_is_shadowbanned": false,
      "body": "Thanks for the upload!",
      "post_date": 1778000000,
      "is_hidden": false
    }
  ],
  "total": 1372,
  "page": 1,
  "per_page": 25,
  "num_pages": 24
}
```

*Used by:* `GET /api/v2/moderation/comments/recent`, `GET /api/v2/moderation/comments/spam`

---

<a id="schema-moderationflagitem"></a>

### ModerationFlagItem

A single pending comment flag.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `user_id` | `integer` | **yes** | — |  |
| `comment_id` | `integer` | **yes** | — |  |
| `reason` | `string` *(nullable)* | **yes** | — |  |
| `date` | `integer` | **yes** | — |  |
| `poster_id` | `integer` | **yes** | — |  |
| `poster_username` | `string` | **yes** | — |  |
| `poster_slug` | `string` | **yes** | — |  |
| `poster_avatar` | `string` | **yes** | — |  |
| `poster_is_shadowbanned` | `boolean` | **yes** | — |  |
| `reporter_username` | `string` | **yes** | — |  |
| `reporter_slug` | `string` | **yes** | — |  |
| `reporter_avatar` | `string` | **yes** | — |  |
| `comment_body` | `string` | **yes** | — |  |
| `gallery_id` | `integer` | **yes** | — |  |
| `gallery_title` | `string` *(nullable)* | **yes** | — |  |

**Example**

```json
{
  "id": 1842,
  "user_id": 90210,
  "comment_id": 4410927,
  "reason": "Duplicate of an existing entry",
  "date": 1778000000,
  "poster_id": 1234,
  "poster_username": "example_user",
  "poster_slug": "example-slug",
  "poster_avatar": "https://cdn.example.net/avatars/90210.png",
  "poster_is_shadowbanned": false,
  "reporter_username": "example_user",
  "reporter_slug": "example-slug",
  "reporter_avatar": "https://cdn.example.net/avatars/90210.png",
  "comment_body": "Thanks for the upload!",
  "gallery_id": 2841902,
  "gallery_title": "example"
}
```

---

<a id="schema-moderationflagslistresponse"></a>

### ModerationFlagsListResponse

Paginated list of pending flags.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `flags` | array of [`ModerationFlagItem`](#schema-moderationflagitem) | **yes** | — |  |
| `total` | `integer` | **yes** | — |  |
| `page` | `integer` | **yes** | — |  |
| `per_page` | `integer` | **yes** | — |  |
| `num_pages` | `integer` | **yes** | — |  |

**Example**

```json
{
  "flags": [
    {
      "id": 1842,
      "user_id": 90210,
      "comment_id": 4410927,
      "reason": "Duplicate of an existing entry",
      "date": 1778000000,
      "poster_id": 1234,
      "poster_username": "example_user",
      "poster_slug": "example-slug",
      "poster_avatar": "https://cdn.example.net/avatars/90210.png",
      "poster_is_shadowbanned": false,
      "reporter_username": "example_user",
      "reporter_slug": "example-slug",
      "reporter_avatar": "https://cdn.example.net/avatars/90210.png",
      "comment_body": "Thanks for the upload!",
      "gallery_id": 2841902,
      "gallery_title": "example"
    }
  ],
  "total": 1372,
  "page": 1,
  "per_page": 25,
  "num_pages": 24
}
```

*Used by:* `GET /api/v2/moderation/flags`

---

<a id="schema-moderationgalleryinfo"></a>

### ModerationGalleryInfo

Moderation status for a gallery.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `hidden` | `boolean` | **yes** | — |  |

**Example**

```json
{
  "id": 2841902,
  "hidden": false
}
```

*Used by:* `GET /api/v2/moderation/galleries/{gallery_id}`

---

<a id="schema-moderationuserinfo"></a>

### ModerationUserInfo

Moderation details for a user. `email` is present only for admins.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `is_shadowbanned` | `boolean` | **yes** | — |  |
| `email` | `string` *(nullable)* | no | — |  |

**Example**

```json
{
  "id": 90210,
  "is_shadowbanned": false,
  "email": "user@example.com"
}
```

*Used by:* `GET /api/v2/moderation/users/{user_id}`

---

<a id="schema-newtagindexentry"></a>

### NewTagIndexEntry

A recently community-minted tag with the count of pending tag-change
suggestions that reference it.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `tag` | [`TagResponse`](#schema-tagresponse) | **yes** | — |  |
| `created_at` | `integer` | **yes** | — |  |
| `pending_gts_count` | `integer` | **yes** | — |  |

**Example**

```json
{
  "tag": {
    "id": 33814,
    "type": "tag",
    "name": "example",
    "slug": "example-slug",
    "url": "https://cdn.example.net/galleries/1451234/3.webp",
    "count": 12,
    "description": "A short human-readable description.",
    "is_community": false,
    "pending_describe_id": "string"
  },
  "created_at": 1778000000,
  "pending_gts_count": 12
}
```

---

<a id="schema-newtagindexresponse"></a>

### NewTagIndexResponse

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `result` | array of [`NewTagIndexEntry`](#schema-newtagindexentry) | **yes** | — |  |

**Example**

```json
{
  "result": [
    {
      "tag": {
        "id": 33814,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "count": 12,
        "description": "A short human-readable description.",
        "is_community": false,
        "pending_describe_id": "string"
      },
      "created_at": 1778000000,
      "pending_gts_count": 12
    }
  ]
}
```

*Used by:* `GET /api/v2/gts/new-tags`

---

<a id="schema-pageinfo"></a>

### PageInfo

Full page/image details for reader.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `number` | `integer` | **yes** | — |  |
| `path` | `string` | **yes** | — |  |
| `width` | `integer` | **yes** | — |  |
| `height` | `integer` | **yes** | — |  |
| `thumbnail` | `string` | **yes** | — |  |
| `thumbnail_width` | `integer` | **yes** | — |  |
| `thumbnail_height` | `integer` | **yes** | — |  |

**Example**

```json
{
  "number": 1,
  "path": "/galleries/2841902/3.webp",
  "width": 1280,
  "height": 1807,
  "thumbnail": "/galleries/2841902/3.webp",
  "thumbnail_width": 1280,
  "thumbnail_height": 1807
}
```

---

<a id="schema-paginatedresponse-commentresponse-"></a>

### PaginatedResponse_CommentResponse_

*Title:* `PaginatedResponse[CommentResponse]`

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `result` | array of [`CommentResponse`](#schema-commentresponse) | **yes** | — |  |
| `num_pages` | `integer` | **yes** | — |  |
| `per_page` | `integer` | no | default: `25` |  |
| `total` | `integer` *(nullable)* | no | — |  |

**Example**

```json
{
  "result": [
    {
      "id": 4410927,
      "gallery_id": 2841902,
      "poster": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png",
        "is_superuser": false,
        "is_staff": false
      },
      "post_date": 1778000000,
      "body": "Thanks for the upload!"
    }
  ],
  "num_pages": 24,
  "per_page": 25,
  "total": 1372
}
```

*Used by:* `GET /api/v2/galleries/{gallery_id}/comments`

---

<a id="schema-paginatedresponse-gallerylistitem-"></a>

### PaginatedResponse_GalleryListItem_

*Title:* `PaginatedResponse[GalleryListItem]`

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `result` | array of [`GalleryListItem`](#schema-gallerylistitem) | **yes** | — |  |
| `num_pages` | `integer` | **yes** | — |  |
| `per_page` | `integer` | no | default: `25` |  |
| `total` | `integer` *(nullable)* | no | — |  |

**Example**

```json
{
  "result": [
    {
      "id": 2841902,
      "media_id": "2841902",
      "english_title": "Example Gallery Title",
      "japanese_title": "サンプルタイトル",
      "thumbnail": "/galleries/2841902/3.webp",
      "thumbnail_width": 1280,
      "thumbnail_height": 1807,
      "num_pages": 24,
      "num_favorites": 12,
      "tag_ids": [
        1234
      ],
      "blacklisted": false
    }
  ],
  "num_pages": 24,
  "per_page": 25,
  "total": 1372
}
```

*Used by:* `GET /api/v2/favorites`, `GET /api/v2/galleries/tagged`, `GET /api/v2/galleries`, `GET /api/v2/moderation/galleries/hidden`, `GET /api/v2/search`

---

<a id="schema-powchallengeresponse"></a>

### PoWChallengeResponse

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `challenge` | `string` | **yes** | — |  |
| `difficulty` | `integer` | **yes** | — |  |

**Example**

```json
{
  "challenge": "string",
  "difficulty": 1
}
```

*Used by:* `GET /api/v2/pow`

---

<a id="schema-popunderinventoryresponse"></a>

### PopunderInventoryResponse

Response for popunder inventory request.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | `string` *(nullable)* | no | — |  |
| `delta` | `integer` *(nullable)* | no | — |  |

**Example**

```json
{
  "name": "example",
  "delta": 1
}
```

*Used by:* `GET /api/v2/zones/i`

---

<a id="schema-recentcomment"></a>

### RecentComment

Comment preview for profile.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `gallery_id` | `integer` | **yes** | — |  |
| `body` | `string` | **yes** | — |  |
| `post_date` | `integer` | **yes** | — |  |
| `gallery_title` | `string` | **yes** | — |  |

**Example**

```json
{
  "id": 4410927,
  "gallery_id": 2841902,
  "body": "Thanks for the upload!",
  "post_date": 1778000000,
  "gallery_title": "example"
}
```

---

<a id="schema-recentfavorite"></a>

### RecentFavorite

Gallery info for recent favorites on profile page.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `media_id` | `string` | **yes** | — |  |
| `thumbnail` | `string` | **yes** | — |  |
| `thumbnail_width` | `integer` | **yes** | — |  |
| `thumbnail_height` | `integer` | **yes** | — |  |
| `english_title` | `string` | **yes** | — |  |
| `japanese_title` | `string` *(nullable)* | no | — |  |
| `num_pages` | `integer` | no | default: `0` |  |
| `tag_ids` | array of `integer` | no | default: `[]` |  |

**Example**

```json
{
  "id": 2841902,
  "media_id": "2841902",
  "thumbnail": "/galleries/2841902/3.webp",
  "thumbnail_width": 1280,
  "thumbnail_height": 1807,
  "english_title": "Example Gallery Title",
  "japanese_title": "サンプルタイトル",
  "num_pages": 24,
  "tag_ids": [
    1234
  ]
}
```

---

<a id="schema-recordpopunderrequest"></a>

### RecordPopunderRequest

Request to record a popunder event.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | `string` | **yes** | — |  |
| `type` | `string` | no | default: `"popunder"` |  |
| `record` | `boolean` | no | default: `true` |  |

**Example**

```json
{
  "name": "example",
  "type": "popunder",
  "record": true
}
```

*Used by:* `POST /api/v2/zones/h`

---

<a id="schema-recordpopunderresponse"></a>

### RecordPopunderResponse

Response for record popunder request.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `success` | `boolean` | no | default: `true` |  |

**Example**

```json
{
  "success": true
}
```

*Used by:* `POST /api/v2/zones/h`

---

<a id="schema-refreshresponse"></a>

### RefreshResponse

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `access_token` | `string` | **yes** | — |  |
| `refresh_token` | `string` | **yes** | — |  |
| `user` | [`UserInfo`](#schema-userinfo) | **yes** | — |  |

**Example**

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0NDIx",
  "refresh_token": "rt_9f2c4b1ae7d34c8fb0a1e5d6c7b8a9f0",
  "user": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png",
    "theme": "black",
    "is_staff": false,
    "is_superuser": false
  }
}
```

*Used by:* `POST /api/v2/auth/refresh`

---

<a id="schema-relatedgalleriesresponse"></a>

### RelatedGalleriesResponse

Response for related galleries endpoint.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `result` | array of [`GalleryListItem`](#schema-gallerylistitem) | **yes** | — |  |

**Example**

```json
{
  "result": [
    {
      "id": 2841902,
      "media_id": "2841902",
      "english_title": "Example Gallery Title",
      "japanese_title": "サンプルタイトル",
      "thumbnail": "/galleries/2841902/3.webp",
      "thumbnail_width": 1280,
      "thumbnail_height": 1807,
      "num_pages": 24,
      "num_favorites": 12,
      "tag_ids": [
        1234
      ],
      "blacklisted": false
    }
  ]
}
```

*Used by:* `GET /api/v2/galleries/{gallery_id}/related`

---

<a id="schema-resolvesuggestionrequest"></a>

### ResolveSuggestionRequest

Body for moderation accept/reject.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `note` | `string` *(nullable)* | no | max length: `500` |  |

**Example**

```json
{
  "note": "Reviewed and approved by staff."
}
```

*Used by:* `POST /api/v2/moderation/gts/{suggestion_id}/accept`, `POST /api/v2/moderation/gts/{suggestion_id}/reject`

---

<a id="schema-resolvetaxonomysuggestionrequest"></a>

### ResolveTaxonomySuggestionRequest

Body for moderation accept/reject.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `note` | `string` *(nullable)* | no | max length: `500` |  |
| `name_override` | `string` *(nullable)* | no | min length: `1`; max length: `100` |  |
| `description_override` | `string` *(nullable)* | no | max length: `2000` |  |

**Example**

```json
{
  "note": "Reviewed and approved by staff.",
  "name_override": "example",
  "description_override": "A short human-readable description."
}
```

*Used by:* `POST /api/v2/moderation/taxonomy/{suggestion_id}/accept`, `POST /api/v2/moderation/taxonomy/{suggestion_id}/reject`

---

<a id="schema-reviewflagrequest"></a>

### ReviewFlagRequest

Request body for reviewing a comment flag.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `action` | `string` enum | **yes** | one of `"approve"`, `"reject"` |  |

**Example**

```json
{
  "action": "approve"
}
```

*Used by:* `POST /api/v2/comments/flags/{flag_id}/review`

---

<a id="schema-reviewflagresponse"></a>

### ReviewFlagResponse

Response for flag review actions.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `success` | `boolean` | **yes** | — |  |
| `is_user_shadowbanned` | `boolean` | no | default: `false` |  |

**Example**

```json
{
  "success": true,
  "is_user_shadowbanned": false
}
```

*Used by:* `POST /api/v2/comments/flags/{flag_id}/review`

---

<a id="schema-sessionlistitem"></a>

### SessionListItem

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `string` | **yes** | — |  |
| `created_at` | `integer` | **yes** | — |  |
| `expires_at` | `integer` | **yes** | — |  |
| `ip_address` | `string` *(nullable)* | no | — |  |
| `user_agent` | `string` *(nullable)* | no | — |  |
| `current` | `boolean` | no | default: `false` |  |

**Example**

```json
{
  "id": "string",
  "created_at": 1778000000,
  "expires_at": 1778000900,
  "ip_address": "203.0.113.42",
  "user_agent": "ExampleApp/1.2.0 (https://example.com)",
  "current": false
}
```

*Used by:* `GET /api/v2/auth/sessions`

---

<a id="schema-shadowbanresponse"></a>

### ShadowbanResponse

Response for shadowban actions.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `shadowbanned` | `boolean` | **yes** | — |  |

**Example**

```json
{
  "shadowbanned": false
}
```

*Used by:* `DELETE /api/v2/moderation/users/{user_id}/shadowban`, `PUT /api/v2/moderation/users/{user_id}/shadowban`

---

<a id="schema-submiteditrequest"></a>

### SubmitEditRequest

Request body for submitting a gallery edit.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `created_tags` | array of [`CreatedTag`](#schema-createdtag) | no | max items: `50`; default: `[]` |  |
| `added_tags` | array of `integer` | no | max items: `100`; default: `[]` |  |
| `removed_tags` | array of `integer` | no | max items: `100`; default: `[]` |  |

**Example**

```json
{
  "created_tags": [
    {
      "type": "tag",
      "name": "example"
    }
  ],
  "added_tags": [
    1
  ],
  "removed_tags": [
    1
  ]
}
```

*Used by:* `POST /api/v2/galleries/{gallery_id}/edit`

---

<a id="schema-submiteditresponse"></a>

### SubmitEditResponse

Response for edit submission.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `success` | `boolean` | **yes** | — |  |
| `edit_id` | `integer` | **yes** | — |  |
| `auto_applied` | `boolean` | **yes** | — |  |

**Example**

```json
{
  "success": true,
  "edit_id": 1842,
  "auto_applied": false
}
```

*Used by:* `POST /api/v2/galleries/{gallery_id}/edit`

---

<a id="schema-successresponse"></a>

### SuccessResponse

Simple success response.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `success` | `boolean` | no | default: `true` |  |
| `message` | `string` *(nullable)* | no | — |  |

**Example**

```json
{
  "success": true,
  "message": "Thanks for the upload!"
}
```

*Used by:* `DELETE /api/v2/auth/sessions/{session_id}`, `DELETE /api/v2/comments/{comment_id}`, `DELETE /api/v2/moderation/api-keys/{key_id}`, `DELETE /api/v2/moderation/comments/{comment_id}/hide`, `DELETE /api/v2/user/keys/{key_id}`, `POST /api/v2/auth/logout/all`, `POST /api/v2/auth/logout`, `POST /api/v2/auth/reset/confirm` *(+10 more)*

---

<a id="schema-suggestionlistresponse"></a>

### SuggestionListResponse

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `result` | array of [`SuggestionResponse`](#schema-suggestionresponse) | **yes** | — |  |
| `has_more` | `boolean` *(nullable)* | no | — |  |
| `num_pages` | `integer` *(nullable)* | no | — |  |
| `total` | `integer` *(nullable)* | no | — |  |

**Example**

```json
{
  "result": [
    {
      "id": "string",
      "gallery_id": 2841902,
      "tag": {
        "id": 1842,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "description": "A short human-readable description."
      },
      "action": "add",
      "status": "pending",
      "score": 5,
      "voter_count": 12,
      "proposer": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "created_at": "2026-05-14T09:21:07Z",
      "resolved_at": "2026-05-14T09:21:07Z",
      "resolver": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "resolution_note": "Reviewed and approved by staff.",
      "reverted_at": "2026-05-14T09:21:07Z",
      "reverter": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "my_vote": 1,
      "tier": "trending"
    }
  ],
  "has_more": false,
  "num_pages": 24,
  "total": 1372
}
```

*Used by:* `GET /api/v2/galleries/{gallery_id}/suggestions`, `GET /api/v2/moderation/gts`

---

<a id="schema-suggestionproposer"></a>

### SuggestionProposer

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `username` | `string` | **yes** | — |  |
| `slug` | `string` *(nullable)* | no | — |  |
| `avatar_url` | `string` *(nullable)* | no | — |  |

**Example**

```json
{
  "id": 90210,
  "username": "example_user",
  "slug": "example-slug",
  "avatar_url": "https://cdn.example.net/avatars/90210.png"
}
```

---

<a id="schema-suggestionresponse"></a>

### SuggestionResponse

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `string` (`uuid`) | **yes** | format: `uuid` |  |
| `gallery_id` | `integer` | **yes** | — |  |
| `tag` | [`SuggestionTag`](#schema-suggestiontag) | **yes** | — |  |
| `action` | `string` enum | **yes** | one of `"add"`, `"remove"` |  |
| `status` | `string` enum | **yes** | one of `"pending"`, `"accepted"`, `"rejected"`, `"superseded"` |  |
| `score` | `integer` *(nullable)* | no | — |  |
| `voter_count` | `integer` | **yes** | — |  |
| `proposer` | [`SuggestionProposer`](#schema-suggestionproposer) | **yes** | — |  |
| `created_at` | `string` (`date-time`) | **yes** | format: `date-time` |  |
| `resolved_at` | `string` (`date-time`) *(nullable)* | no | format: `date-time` |  |
| `resolver` | [`SuggestionProposer`](#schema-suggestionproposer) *(nullable)* | no | — |  |
| `resolution_note` | `string` *(nullable)* | no | — |  |
| `reverted_at` | `string` (`date-time`) *(nullable)* | no | format: `date-time` |  |
| `reverter` | [`SuggestionProposer`](#schema-suggestionproposer) *(nullable)* | no | — |  |
| `my_vote` | `integer` *(nullable)* | no | — |  |
| `tier` | `string` enum *(nullable)* | no | one of `"trending"`, `"active"`, `"declined"`, `"hidden"` |  |

**Example**

```json
{
  "id": "string",
  "gallery_id": 2841902,
  "tag": {
    "id": 1842,
    "type": "tag",
    "name": "example",
    "slug": "example-slug",
    "url": "https://cdn.example.net/galleries/1451234/3.webp",
    "description": "A short human-readable description."
  },
  "action": "add",
  "status": "pending",
  "score": 5,
  "voter_count": 12,
  "proposer": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png"
  },
  "created_at": "2026-05-14T09:21:07Z",
  "resolved_at": "2026-05-14T09:21:07Z",
  "resolver": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png"
  },
  "resolution_note": "Reviewed and approved by staff.",
  "reverted_at": "2026-05-14T09:21:07Z",
  "reverter": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png"
  },
  "my_vote": 1,
  "tier": "trending"
}
```

*Used by:* `POST /api/v2/galleries/{gallery_id}/suggestions/{suggestion_id}/vote`, `POST /api/v2/galleries/{gallery_id}/suggestions`

---

<a id="schema-suggestiontag"></a>

### SuggestionTag

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `type` | `string` | **yes** | — |  |
| `name` | `string` | **yes** | — |  |
| `slug` | `string` | **yes** | — |  |
| `url` | `string` | **yes** | — |  |
| `description` | `string` *(nullable)* | no | — |  |

**Example**

```json
{
  "id": 1842,
  "type": "tag",
  "name": "example",
  "slug": "example-slug",
  "url": "https://cdn.example.net/galleries/1451234/3.webp",
  "description": "A short human-readable description."
}
```

---

<a id="schema-suggestiontiercounts"></a>

### SuggestionTierCounts

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `trending` | `integer` | no | default: `0` |  |
| `active` | `integer` | no | default: `0` |  |
| `declined` | `integer` | no | default: `0` |  |
| `hidden` | `integer` | no | default: `0` |  |

**Example**

```json
{
  "trending": 1,
  "active": 1,
  "declined": 1,
  "hidden": 1
}
```

---

<a id="schema-tagpaginatedresponse"></a>

### TagPaginatedResponse

Paginated tag response with optional alphabet mapping.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `result` | array of [`TagResponse`](#schema-tagresponse) | **yes** | — |  |
| `num_pages` | `integer` | **yes** | — |  |
| `per_page` | `integer` | no | default: `120` |  |
| `total` | `integer` *(nullable)* | no | — |  |
| `alphabet` | object map of `string` → array of `integer` *(nullable)* *(nullable)* | no | — |  |

**Example**

```json
{
  "result": [
    {
      "id": 33814,
      "type": "tag",
      "name": "example",
      "slug": "example-slug",
      "url": "https://cdn.example.net/galleries/1451234/3.webp",
      "count": 12,
      "description": "A short human-readable description.",
      "is_community": false,
      "pending_describe_id": "string"
    }
  ],
  "num_pages": 24,
  "per_page": 120,
  "total": 1372,
  "alphabet": {
    "header": [
      1
    ]
  }
}
```

*Used by:* `GET /api/v2/tags/{tag_type}`

---

<a id="schema-tagresponse"></a>

### TagResponse

Tag response matching Django format.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `type` | `string` | **yes** | — |  |
| `name` | `string` | **yes** | — |  |
| `slug` | `string` | **yes** | — |  |
| `url` | `string` | **yes** | — |  |
| `count` | `integer` | **yes** | — |  |
| `description` | `string` *(nullable)* | no | — |  |
| `is_community` | `boolean` *(nullable)* | no | — |  |
| `pending_describe_id` | `string` *(nullable)* | no | — |  |

**Example**

```json
{
  "id": 33814,
  "type": "tag",
  "name": "example",
  "slug": "example-slug",
  "url": "https://cdn.example.net/galleries/1451234/3.webp",
  "count": 12,
  "description": "A short human-readable description.",
  "is_community": false,
  "pending_describe_id": "string"
}
```

*Used by:* `GET /api/v2/tags/ids`, `GET /api/v2/tags/{tag_type}/{slug}`, `POST /api/v2/tags/search`

---

<a id="schema-taxonomycommentauthor"></a>

### TaxonomyCommentAuthor

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `username` | `string` | **yes** | — |  |
| `slug` | `string` | **yes** | — |  |
| `avatar_url` | `string` *(nullable)* | no | — |  |
| `is_staff` | `boolean` | no | default: `false` |  |
| `is_superuser` | `boolean` | no | default: `false` |  |

**Example**

```json
{
  "id": 4410927,
  "username": "example_user",
  "slug": "example-slug",
  "avatar_url": "https://cdn.example.net/avatars/90210.png",
  "is_staff": false,
  "is_superuser": false
}
```

---

<a id="schema-taxonomycommentlistresponse"></a>

### TaxonomyCommentListResponse

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `result` | array of [`TaxonomyCommentResponse`](#schema-taxonomycommentresponse) | **yes** | — |  |
| `has_more` | `boolean` *(nullable)* | no | — |  |
| `num_pages` | `integer` *(nullable)* | no | — |  |
| `total` | `integer` *(nullable)* | no | — |  |

**Example**

```json
{
  "result": [
    {
      "id": "string",
      "body": "Thanks for the upload!",
      "author": {
        "id": 4410927,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png",
        "is_staff": false,
        "is_superuser": false
      },
      "created_at": "2026-05-14T09:21:07Z",
      "can_delete": false,
      "link_previews": []
    }
  ],
  "has_more": false,
  "num_pages": 24,
  "total": 1372
}
```

*Used by:* `GET /api/v2/taxonomy/{suggestion_id}/comments`

---

<a id="schema-taxonomycommentresponse"></a>

### TaxonomyCommentResponse

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `string` (`uuid`) | **yes** | format: `uuid` |  |
| `body` | `string` | **yes** | — |  |
| `author` | [`TaxonomyCommentAuthor`](#schema-taxonomycommentauthor) | **yes** | — |  |
| `created_at` | `string` (`date-time`) | **yes** | format: `date-time` |  |
| `can_delete` | `boolean` | no | default: `false` |  |
| `link_previews` | array of [`TaxonomyLinkPreview`](#schema-taxonomylinkpreview) \| [`GalleryLinkPreview`](#schema-gallerylinkpreview) | no | default: `[]` |  |

**Example**

```json
{
  "id": "string",
  "body": "Thanks for the upload!",
  "author": {
    "id": 4410927,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png",
    "is_staff": false,
    "is_superuser": false
  },
  "created_at": "2026-05-14T09:21:07Z",
  "can_delete": false,
  "link_previews": [
    {
      "start": 1,
      "end": 1,
      "matched": "string",
      "kind": "taxonomy",
      "suggestion": {
        "id": "string",
        "action": "create",
        "status": "pending",
        "score": 5,
        "voter_count": 12,
        "proposer": null,
        "proposer_note": "Reviewed and approved by staff.",
        "created_at": "2026-05-14T09:21:07Z",
        "edited_at": "2026-05-14T09:21:07Z",
        "resolved_at": "2026-05-14T09:21:07Z",
        "resolution_note": "Reviewed and approved by staff.",
        "resolver": null,
        "target_tag": null,
        "merge_into_tag": null,
        "new_name": "example",
        "new_type": "tag",
        "new_description": "A short human-readable description.",
        "accepted_type": "tag",
        "accepted_name": "example",
        "accepted_description": "A short human-readable description.",
        "resolved_tag": null,
        "my_vote": 1,
        "tier": "trending",
        "tier_page": 1,
        "comment_count": 12,
        "recent_comments": []
      }
    }
  ]
}
```

*Used by:* `POST /api/v2/taxonomy/{suggestion_id}/comments`

---

<a id="schema-taxonomylinkpreview"></a>

### TaxonomyLinkPreview

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `start` | `integer` | **yes** | — |  |
| `end` | `integer` | **yes** | — |  |
| `matched` | `string` | **yes** | — |  |
| `kind` | `string` | no | default: `"taxonomy"` |  |
| `suggestion` | [`TaxonomySuggestionResponse`](#schema-taxonomysuggestionresponse) | **yes** | — |  |

**Example**

```json
{
  "start": 1,
  "end": 1,
  "matched": "string",
  "kind": "taxonomy",
  "suggestion": {
    "id": "string",
    "action": "create",
    "status": "pending",
    "score": 5,
    "voter_count": 12,
    "proposer": {
      "id": 90210,
      "username": "example_user",
      "slug": "example-slug",
      "avatar_url": "https://cdn.example.net/avatars/90210.png"
    },
    "proposer_note": "Reviewed and approved by staff.",
    "created_at": "2026-05-14T09:21:07Z",
    "edited_at": "2026-05-14T09:21:07Z",
    "resolved_at": "2026-05-14T09:21:07Z",
    "resolution_note": "Reviewed and approved by staff.",
    "resolver": {
      "id": 90210,
      "username": "example_user",
      "slug": "example-slug",
      "avatar_url": "https://cdn.example.net/avatars/90210.png"
    },
    "target_tag": {
      "id": 1842,
      "type": "tag",
      "name": "example",
      "slug": "example-slug",
      "url": "https://cdn.example.net/galleries/1451234/3.webp",
      "count": 12,
      "description": "A short human-readable description."
    },
    "merge_into_tag": {
      "id": 1842,
      "type": "tag",
      "name": "example",
      "slug": "example-slug",
      "url": "https://cdn.example.net/galleries/1451234/3.webp",
      "count": 12,
      "description": "A short human-readable description."
    },
    "new_name": "example",
    "new_type": "tag",
    "new_description": "A short human-readable description.",
    "accepted_type": "tag",
    "accepted_name": "example",
    "accepted_description": "A short human-readable description.",
    "resolved_tag": {
      "id": 1842,
      "type": "tag",
      "name": "example",
      "slug": "example-slug",
      "url": "https://cdn.example.net/galleries/1451234/3.webp",
      "count": 12,
      "description": "A short human-readable description."
    },
    "my_vote": 1,
    "tier": "trending",
    "tier_page": 1,
    "comment_count": 12,
    "recent_comments": [
      {
        "id": "string",
        "body": "Thanks for the upload!",
        "author": null,
        "created_at": "2026-05-14T09:21:07Z",
        "can_delete": false,
        "link_previews": []
      }
    ]
  }
}
```

---

<a id="schema-taxonomysuggestioneditchange"></a>

### TaxonomySuggestionEditChange

One field's before/after within an edit. Tag-valued fields (target_tag,
merge_into_tag) carry a human-readable 'type:name' snapshot rather than an
id, so the history renders even after the tag is deleted.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `field` | `string` | **yes** | — |  |
| `old_value` | `string` *(nullable)* | no | — |  |
| `new_value` | `string` *(nullable)* | no | — |  |

**Example**

```json
{
  "field": "string",
  "old_value": "string",
  "new_value": "string"
}
```

---

<a id="schema-taxonomysuggestioneditentry"></a>

### TaxonomySuggestionEditEntry

One edit event: everything a single PATCH changed, plus who/when and an
optional free-text summary describing why.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `string` (`uuid`) | **yes** | format: `uuid` |  |
| `created_at` | `string` (`date-time`) | **yes** | format: `date-time` |  |
| `summary` | `string` *(nullable)* | no | — |  |
| `changes` | array of [`TaxonomySuggestionEditChange`](#schema-taxonomysuggestioneditchange) | **yes** | — |  |
| `editor` | [`TaxonomySuggestionProposer`](#schema-taxonomysuggestionproposer) *(nullable)* | no | — |  |

**Example**

```json
{
  "id": "string",
  "created_at": "2026-05-14T09:21:07Z",
  "summary": "string",
  "changes": [
    {
      "field": "string",
      "old_value": "string",
      "new_value": "string"
    }
  ],
  "editor": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png"
  }
}
```

---

<a id="schema-taxonomysuggestioneditlistresponse"></a>

### TaxonomySuggestionEditListResponse

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `result` | array of [`TaxonomySuggestionEditEntry`](#schema-taxonomysuggestioneditentry) | **yes** | — |  |

**Example**

```json
{
  "result": [
    {
      "id": "string",
      "created_at": "2026-05-14T09:21:07Z",
      "summary": "string",
      "changes": [
        {
          "field": "string",
          "old_value": "string",
          "new_value": "string"
        }
      ],
      "editor": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      }
    }
  ]
}
```

*Used by:* `GET /api/v2/taxonomy/{suggestion_id}/edits`

---

<a id="schema-taxonomysuggestionlistresponse"></a>

### TaxonomySuggestionListResponse

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `result` | array of [`TaxonomySuggestionResponse`](#schema-taxonomysuggestionresponse) | **yes** | — |  |
| `has_more` | `boolean` *(nullable)* | no | — |  |
| `num_pages` | `integer` *(nullable)* | no | — |  |
| `total` | `integer` *(nullable)* | no | — |  |

**Example**

```json
{
  "result": [
    {
      "id": "string",
      "action": "create",
      "status": "pending",
      "score": 5,
      "voter_count": 12,
      "proposer": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "proposer_note": "Reviewed and approved by staff.",
      "created_at": "2026-05-14T09:21:07Z",
      "edited_at": "2026-05-14T09:21:07Z",
      "resolved_at": "2026-05-14T09:21:07Z",
      "resolution_note": "Reviewed and approved by staff.",
      "resolver": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "target_tag": {
        "id": 1842,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "count": 12,
        "description": "A short human-readable description."
      },
      "merge_into_tag": {
        "id": 1842,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "count": 12,
        "description": "A short human-readable description."
      },
      "new_name": "example",
      "new_type": "tag",
      "new_description": "A short human-readable description.",
      "accepted_type": "tag",
      "accepted_name": "example",
      "accepted_description": "A short human-readable description.",
      "resolved_tag": {
        "id": 1842,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "count": 12,
        "description": "A short human-readable description."
      },
      "my_vote": 1,
      "tier": "trending",
      "tier_page": 1,
      "comment_count": 12,
      "recent_comments": [
        {
          "id": "string",
          "body": "Thanks for the upload!",
          "author": null,
          "created_at": "2026-05-14T09:21:07Z",
          "can_delete": false,
          "link_previews": []
        }
      ]
    }
  ],
  "has_more": false,
  "num_pages": 24,
  "total": 1372
}
```

*Used by:* `GET /api/v2/taxonomy/resolved`, `GET /api/v2/taxonomy`

---

<a id="schema-taxonomysuggestionproposer"></a>

### TaxonomySuggestionProposer

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `username` | `string` | **yes** | — |  |
| `slug` | `string` *(nullable)* | no | — |  |
| `avatar_url` | `string` *(nullable)* | no | — |  |

**Example**

```json
{
  "id": 90210,
  "username": "example_user",
  "slug": "example-slug",
  "avatar_url": "https://cdn.example.net/avatars/90210.png"
}
```

---

<a id="schema-taxonomysuggestionresolver"></a>

### TaxonomySuggestionResolver

Staff who resolved a suggestion. Included on resolved entries.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `username` | `string` | **yes** | — |  |
| `slug` | `string` *(nullable)* | no | — |  |
| `avatar_url` | `string` *(nullable)* | no | — |  |

**Example**

```json
{
  "id": 90210,
  "username": "example_user",
  "slug": "example-slug",
  "avatar_url": "https://cdn.example.net/avatars/90210.png"
}
```

---

<a id="schema-taxonomysuggestionresponse"></a>

### TaxonomySuggestionResponse

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `string` (`uuid`) | **yes** | format: `uuid` |  |
| `action` | `string` enum | **yes** | one of `"create"`, `"rename"`, `"merge"`, `"describe"` |  |
| `status` | `string` enum | **yes** | one of `"pending"`, `"accepted"`, `"rejected"`, `"withdrawn"` |  |
| `score` | `integer` | **yes** | — |  |
| `voter_count` | `integer` | **yes** | — |  |
| `proposer` | [`TaxonomySuggestionProposer`](#schema-taxonomysuggestionproposer) | **yes** | — |  |
| `proposer_note` | `string` *(nullable)* | no | — |  |
| `created_at` | `string` (`date-time`) | **yes** | format: `date-time` |  |
| `edited_at` | `string` (`date-time`) *(nullable)* | no | format: `date-time` |  |
| `resolved_at` | `string` (`date-time`) *(nullable)* | no | format: `date-time` |  |
| `resolution_note` | `string` *(nullable)* | no | — |  |
| `resolver` | [`TaxonomySuggestionResolver`](#schema-taxonomysuggestionresolver) *(nullable)* | no | — |  |
| `target_tag` | [`TaxonomySuggestionTag`](#schema-taxonomysuggestiontag) *(nullable)* | no | — |  |
| `merge_into_tag` | [`TaxonomySuggestionTag`](#schema-taxonomysuggestiontag) *(nullable)* | no | — |  |
| `new_name` | `string` *(nullable)* | no | — |  |
| `new_type` | `string` *(nullable)* | no | — |  |
| `new_description` | `string` *(nullable)* | no | — |  |
| `accepted_type` | `string` *(nullable)* | no | — |  |
| `accepted_name` | `string` *(nullable)* | no | — |  |
| `accepted_description` | `string` *(nullable)* | no | — |  |
| `resolved_tag` | [`TaxonomySuggestionTag`](#schema-taxonomysuggestiontag) *(nullable)* | no | — |  |
| `my_vote` | `integer` *(nullable)* | no | — |  |
| `tier` | `string` enum *(nullable)* | no | one of `"trending"`, `"active"`, `"declined"`, `"hidden"`, `"mine"` |  |
| `tier_page` | `integer` *(nullable)* | no | — |  |
| `comment_count` | `integer` | no | default: `0` |  |
| `recent_comments` | array of [`TaxonomyCommentResponse`](#schema-taxonomycommentresponse) | no | default: `[]` |  |

**Example**

```json
{
  "id": "string",
  "action": "create",
  "status": "pending",
  "score": 5,
  "voter_count": 12,
  "proposer": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png"
  },
  "proposer_note": "Reviewed and approved by staff.",
  "created_at": "2026-05-14T09:21:07Z",
  "edited_at": "2026-05-14T09:21:07Z",
  "resolved_at": "2026-05-14T09:21:07Z",
  "resolution_note": "Reviewed and approved by staff.",
  "resolver": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png"
  },
  "target_tag": {
    "id": 1842,
    "type": "tag",
    "name": "example",
    "slug": "example-slug",
    "url": "https://cdn.example.net/galleries/1451234/3.webp",
    "count": 12,
    "description": "A short human-readable description."
  },
  "merge_into_tag": {
    "id": 1842,
    "type": "tag",
    "name": "example",
    "slug": "example-slug",
    "url": "https://cdn.example.net/galleries/1451234/3.webp",
    "count": 12,
    "description": "A short human-readable description."
  },
  "new_name": "example",
  "new_type": "tag",
  "new_description": "A short human-readable description.",
  "accepted_type": "tag",
  "accepted_name": "example",
  "accepted_description": "A short human-readable description.",
  "resolved_tag": {
    "id": 1842,
    "type": "tag",
    "name": "example",
    "slug": "example-slug",
    "url": "https://cdn.example.net/galleries/1451234/3.webp",
    "count": 12,
    "description": "A short human-readable description."
  },
  "my_vote": 1,
  "tier": "trending",
  "tier_page": 1,
  "comment_count": 12,
  "recent_comments": [
    {
      "id": "string",
      "body": "Thanks for the upload!",
      "author": {
        "id": 4410927,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png",
        "is_staff": false,
        "is_superuser": false
      },
      "created_at": "2026-05-14T09:21:07Z",
      "can_delete": false,
      "link_previews": []
    }
  ]
}
```

*Used by:* `GET /api/v2/taxonomy/{suggestion_id}`, `PATCH /api/v2/taxonomy/{suggestion_id}`, `POST /api/v2/taxonomy/{suggestion_id}/vote`, `POST /api/v2/taxonomy`

---

<a id="schema-taxonomysuggestionstats"></a>

### TaxonomySuggestionStats

Taxonomy activity summary: pending count + recently-accepted suggestions.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `pending` | `integer` | **yes** | — |  |
| `accepted_total` | `integer` | **yes** | — |  |
| `rejected_total` | `integer` | **yes** | — |  |
| `accepted_30d` | `integer` | **yes** | — |  |
| `accepted_7d` | `integer` | **yes** | — |  |
| `created_30d` | `integer` | **yes** | — |  |
| `renamed_30d` | `integer` | **yes** | — |  |
| `merged_30d` | `integer` | **yes** | — |  |
| `described_30d` | `integer` | **yes** | — |  |
| `trending_count` | `integer` | no | default: `0` |  |
| `active_count` | `integer` | no | default: `0` |  |
| `declined_count` | `integer` | no | default: `0` |  |
| `recent_accepted` | array of [`TaxonomySuggestionResponse`](#schema-taxonomysuggestionresponse) | **yes** | — |  |

**Example**

```json
{
  "pending": 1,
  "accepted_total": 1372,
  "rejected_total": 1372,
  "accepted_30d": 1,
  "accepted_7d": 1,
  "created_30d": 1,
  "renamed_30d": 1,
  "merged_30d": 1,
  "described_30d": 1,
  "trending_count": 12,
  "active_count": 12,
  "declined_count": 12,
  "recent_accepted": [
    {
      "id": "string",
      "action": "create",
      "status": "pending",
      "score": 5,
      "voter_count": 12,
      "proposer": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "proposer_note": "Reviewed and approved by staff.",
      "created_at": "2026-05-14T09:21:07Z",
      "edited_at": "2026-05-14T09:21:07Z",
      "resolved_at": "2026-05-14T09:21:07Z",
      "resolution_note": "Reviewed and approved by staff.",
      "resolver": {
        "id": 90210,
        "username": "example_user",
        "slug": "example-slug",
        "avatar_url": "https://cdn.example.net/avatars/90210.png"
      },
      "target_tag": {
        "id": 1842,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "count": 12,
        "description": "A short human-readable description."
      },
      "merge_into_tag": {
        "id": 1842,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "count": 12,
        "description": "A short human-readable description."
      },
      "new_name": "example",
      "new_type": "tag",
      "new_description": "A short human-readable description.",
      "accepted_type": "tag",
      "accepted_name": "example",
      "accepted_description": "A short human-readable description.",
      "resolved_tag": {
        "id": 1842,
        "type": "tag",
        "name": "example",
        "slug": "example-slug",
        "url": "https://cdn.example.net/galleries/1451234/3.webp",
        "count": 12,
        "description": "A short human-readable description."
      },
      "my_vote": 1,
      "tier": "trending",
      "tier_page": 1,
      "comment_count": 12,
      "recent_comments": [
        {
          "id": "string",
          "body": "Thanks for the upload!",
          "author": null,
          "created_at": "2026-05-14T09:21:07Z",
          "can_delete": false,
          "link_previews": []
        }
      ]
    }
  ]
}
```

*Used by:* `GET /api/v2/taxonomy/stats`

---

<a id="schema-taxonomysuggestiontag"></a>

### TaxonomySuggestionTag

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` *(nullable)* | no | — |  |
| `type` | `string` | **yes** | — |  |
| `name` | `string` | **yes** | — |  |
| `slug` | `string` | **yes** | — |  |
| `url` | `string` *(nullable)* | no | — |  |
| `count` | `integer` *(nullable)* | no | — |  |
| `description` | `string` *(nullable)* | no | — |  |

**Example**

```json
{
  "id": 1842,
  "type": "tag",
  "name": "example",
  "slug": "example-slug",
  "url": "https://cdn.example.net/galleries/1451234/3.webp",
  "count": 12,
  "description": "A short human-readable description."
}
```

---

<a id="schema-tokenresponse"></a>

### TokenResponse

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `access_token` | `string` | **yes** | — |  |
| `refresh_token` | `string` | **yes** | — |  |
| `user` | [`UserInfo`](#schema-userinfo) | **yes** | — |  |

**Example**

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0NDIx",
  "refresh_token": "rt_9f2c4b1ae7d34c8fb0a1e5d6c7b8a9f0",
  "user": {
    "id": 90210,
    "username": "example_user",
    "slug": "example-slug",
    "avatar_url": "https://cdn.example.net/avatars/90210.png",
    "theme": "black",
    "is_staff": false,
    "is_superuser": false
  }
}
```

*Used by:* `POST /api/v2/auth/login`, `POST /api/v2/auth/register`

---

<a id="schema-updateprofilerequest"></a>

### UpdateProfileRequest

Request body for updating user profile.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `username` | `string` *(nullable)* | no | — |  |
| `email` | `string` *(nullable)* | no | — |  |
| `about` | `string` *(nullable)* | no | — |  |
| `favorite_tags` | `string` *(nullable)* | no | — |  |
| `theme` | `string` *(nullable)* | no | — |  |
| `current_password` | `string` *(nullable)* | no | — |  |
| `new_password` | `string` *(nullable)* | no | — |  |
| `default_avatar` | `string` enum *(nullable)* | no | one of `"default"`, `"classic"` |  |

**Example**

```json
{
  "username": "example_user",
  "email": "user@example.com",
  "about": "Long-time reader. Mostly here for the artbooks.",
  "favorite_tags": "english",
  "theme": "string",
  "current_password": "S3cur3-Passphrase!",
  "new_password": "S3cur3-Passphrase!",
  "default_avatar": "default"
}
```

*Used by:* `PUT /api/v2/user`

---

<a id="schema-updateprofileresponse"></a>

### UpdateProfileResponse

Response for profile update.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `success` | `boolean` | **yes** | — |  |
| `username` | `string` | **yes** | — |  |
| `email` | `string` *(nullable)* | no | — |  |
| `avatar_url` | `string` | **yes** | — |  |
| `about` | `string` | no | default: `""` |  |
| `favorite_tags` | `string` | no | default: `""` |  |
| `theme` | `string` | no | default: `"black"` |  |

**Example**

```json
{
  "success": true,
  "username": "example_user",
  "email": "user@example.com",
  "avatar_url": "https://cdn.example.net/avatars/90210.png",
  "about": "Long-time reader. Mostly here for the artbooks.",
  "favorite_tags": "english",
  "theme": "black"
}
```

*Used by:* `PUT /api/v2/user`

---

<a id="schema-userinfo"></a>

### UserInfo

User info returned in token responses.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `username` | `string` | **yes** | — |  |
| `slug` | `string` | **yes** | — |  |
| `avatar_url` | `string` | **yes** | — |  |
| `theme` | `string` | no | default: `"black"` |  |
| `is_staff` | `boolean` | no | default: `false` |  |
| `is_superuser` | `boolean` | no | default: `false` |  |

**Example**

```json
{
  "id": 90210,
  "username": "example_user",
  "slug": "example-slug",
  "avatar_url": "https://cdn.example.net/avatars/90210.png",
  "theme": "black",
  "is_staff": false,
  "is_superuser": false
}
```

---

<a id="schema-usermeresponse"></a>

### UserMeResponse

Full user profile. Email hidden for API key auth.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `username` | `string` | **yes** | — |  |
| `slug` | `string` | **yes** | — |  |
| `avatar_url` | `string` | **yes** | — |  |
| `theme` | `string` | no | default: `"black"` |  |
| `is_staff` | `boolean` | no | default: `false` |  |
| `is_superuser` | `boolean` | no | default: `false` |  |
| `about` | `string` | no | default: `""` |  |
| `favorite_tags` | `string` | no | default: `""` |  |
| `email` | `string` *(nullable)* | no | — |  |

**Example**

```json
{
  "id": 90210,
  "username": "example_user",
  "slug": "example-slug",
  "avatar_url": "https://cdn.example.net/avatars/90210.png",
  "theme": "black",
  "is_staff": false,
  "is_superuser": false,
  "about": "Long-time reader. Mostly here for the artbooks.",
  "favorite_tags": "english",
  "email": "user@example.com"
}
```

*Used by:* `GET /api/v2/user`

---

<a id="schema-userprofileresponse"></a>

### UserProfileResponse

Full user profile response.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `username` | `string` | **yes** | — |  |
| `slug` | `string` | **yes** | — |  |
| `avatar_url` | `string` | **yes** | — |  |
| `is_superuser` | `boolean` | no | default: `false` |  |
| `is_staff` | `boolean` | no | default: `false` |  |
| `date_joined` | `integer` | **yes** | — |  |
| `about` | `string` | no | default: `""` |  |
| `favorite_tags` | `string` | no | default: `""` |  |
| `recent_favorites` | array of [`RecentFavorite`](#schema-recentfavorite) | **yes** | — |  |
| `recent_comments` | array of [`RecentComment`](#schema-recentcomment) | **yes** | — |  |

**Example**

```json
{
  "id": 90210,
  "username": "example_user",
  "slug": "example-slug",
  "avatar_url": "https://cdn.example.net/avatars/90210.png",
  "is_superuser": false,
  "is_staff": false,
  "date_joined": 1778000000,
  "about": "Long-time reader. Mostly here for the artbooks.",
  "favorite_tags": "english",
  "recent_favorites": [
    {
      "id": 2841902,
      "media_id": "2841902",
      "thumbnail": "/galleries/2841902/3.webp",
      "thumbnail_width": 1280,
      "thumbnail_height": 1807,
      "english_title": "Example Gallery Title",
      "japanese_title": "サンプルタイトル",
      "num_pages": 24,
      "tag_ids": [
        1234
      ]
    }
  ],
  "recent_comments": [
    {
      "id": 4410927,
      "gallery_id": 2841902,
      "body": "Thanks for the upload!",
      "post_date": 1778000000,
      "gallery_title": "example"
    }
  ]
}
```

*Used by:* `GET /api/v2/users/{user_id}/{slug}`

---

<a id="schema-userpublic"></a>

### UserPublic

Public user information (shown in comments, etc.).

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | `integer` | **yes** | — |  |
| `username` | `string` | **yes** | — |  |
| `slug` | `string` | **yes** | — |  |
| `avatar_url` | `string` | **yes** | — |  |
| `is_superuser` | `boolean` | no | default: `false` |  |
| `is_staff` | `boolean` | no | default: `false` |  |

**Example**

```json
{
  "id": 90210,
  "username": "example_user",
  "slug": "example-slug",
  "avatar_url": "https://cdn.example.net/avatars/90210.png",
  "is_superuser": false,
  "is_staff": false
}
```

---

<a id="schema-validationerror"></a>

### ValidationError

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `loc` | array of `string` \| `integer` | **yes** | — | Location |
| `msg` | `string` | **yes** | — | Message |
| `type` | `string` | **yes** | — | Error Type |
| `input` | `any` | no | — |  |
| `ctx` | `object` | no | — | Context |

**Example**

```json
{
  "loc": [
    "string"
  ],
  "msg": "string",
  "type": "tag",
  "input": "string",
  "ctx": {}
}
```

---

<a id="schema-voterequest"></a>

### VoteRequest

Request body for voting on an edit.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `accept` | `boolean` | **yes** | — |  |

**Example**

```json
{
  "accept": false
}
```

*Used by:* `POST /api/v2/moderation/edits/{edit_id}/vote`

---

<a id="schema-voteresponse"></a>

### VoteResponse

Response for vote action.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `success` | `boolean` | **yes** | — |  |
| `upvotes` | `integer` | **yes** | — |  |
| `downvotes` | `integer` | **yes** | — |  |

**Example**

```json
{
  "success": true,
  "upvotes": 5,
  "downvotes": 5
}
```

*Used by:* `POST /api/v2/moderation/edits/{edit_id}/vote`

---

<a id="schema-zonesresponse"></a>

### ZonesResponse

All-zones response. Missing key = no ad for that slot.

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `zones` | object map of `string` → [`HtmlSlot`](#schema-htmlslot) \| [`CreativeSlot`](#schema-creativeslot) | **yes** | — |  |

**Example**

```json
{
  "zones": {
    "header": {
      "type": "html",
      "html": "<div id=\"ad-slot\"></div>"
    }
  }
}
```

*Used by:* `GET /api/v2/zones`

---

## Appendices

### A. Enum catalogue

Every closed value set in the specification, with where it appears. Reject unknown values client-side rather than passing them through.

| Values | Appears in |
|---|---|
| `"create"`, `"rename"`, `"merge"`, `"describe"` | [`Body_create_taxonomy_suggestion_api_v2_taxonomy_post`](#schema-body-create-taxonomy-suggestion-api-v2-taxonomy-post) → `action`; [`Body_edit_taxonomy_suggestion_api_v2_taxonomy__suggestion_id__patch`](#schema-body-edit-taxonomy-suggestion-api-v2-taxonomy-suggestion-id-patch) → `action`; [`TaxonomySuggestionResponse`](#schema-taxonomysuggestionresponse) → `action` |
| `"tag"`, `"artist"`, `"parody"`, `"character"`, `"group"`, `"language"`, `"category"` | [`Body_create_taxonomy_suggestion_api_v2_taxonomy_post`](#schema-body-create-taxonomy-suggestion-api-v2-taxonomy-post) → `new_type`; [`Body_edit_taxonomy_suggestion_api_v2_taxonomy__suggestion_id__patch`](#schema-body-edit-taxonomy-suggestion-api-v2-taxonomy-suggestion-id-patch) → `new_type`; [`CreateTagRequest`](#schema-createtagrequest) → `type` |
| `"date"`, `"popular"`, `"popular-today"`, `"popular-week"`, `"popular-month"` | `GET /api/v2/galleries/tagged` → `sort`; `GET /api/v2/search` → `sort` |
| `"add"`, `"remove"` | [`Body_create_suggestion_api_v2_galleries__gallery_id__suggestions_post`](#schema-body-create-suggestion-api-v2-galleries-gallery-id-suggestions-post) → `action`; [`SuggestionResponse`](#schema-suggestionresponse) → `action` |
| `"zip"`, `"cbz"`, `"torrent"` | `POST /api/v2/galleries/{gallery_id}/download` → `format` |
| `"name"`, `"popular"` | `GET /api/v2/tags/{tag_type}` → `sort` |
| `"created"`, `"last_used"` | `GET /api/v2/moderation/api-keys` → `sort` |
| `"approve"`, `"reject"` | [`ReviewFlagRequest`](#schema-reviewflagrequest) → `action` |
| `"pending"`, `"accepted"`, `"rejected"`, `"superseded"` | [`SuggestionResponse`](#schema-suggestionresponse) → `status` |
| `"trending"`, `"active"`, `"declined"`, `"hidden"` | [`SuggestionResponse`](#schema-suggestionresponse) → `tier` |
| `"pending"`, `"accepted"`, `"rejected"`, `"withdrawn"` | [`TaxonomySuggestionResponse`](#schema-taxonomysuggestionresponse) → `status` |
| `"trending"`, `"active"`, `"declined"`, `"hidden"`, `"mine"` | [`TaxonomySuggestionResponse`](#schema-taxonomysuggestionresponse) → `tier` |
| `"default"`, `"classic"` | [`UpdateProfileRequest`](#schema-updateprofilerequest) → `default_avatar` |

**Value sets encoded as regex.** Some parameters constrain their values with a `pattern` instead of an `enum`; these are effectively enums too and are listed in each operation's Constraints column. The notable ones:

| Parameter | Permitted values |
|---|---|
| `action` | `add`, `remove` |
| `discussion` | `with`, `without` |
| `edited` | `yes`, `no` |
| `sort` | `asc`, `desc` |
| `sort` | `score`, `voters`, `newest`, `oldest` |
| `sort_by` | `resolved_at`, `score`, `votes`, `comment_count`, `last_comment_at`, `created_at` |
| `sort_by` | `score`, `votes`, `comment_count`, `last_comment_at`, `created_at` |
| `sort_by` | `starvation`, `voters`, `score`, `gallery_age`, `created_at` |
| `status` | `all`, `accepted`, `rejected` |
| `status` | `pending`, `accepted`, `rejected` |
| `tag_type` | `tag`, `artist`, `parody`, `character`, `group`, `language`, `category` |
| `tier` | `all`, `trending`, `active`, `declined`, `hidden`, `mine`, `history` |
| `tier` | `all`, `trending`, `active`, `declined`, `mine` |

### B. Search query syntax

`GET /api/v2/search` accepts a single `query` string supporting the following operators (as documented on the operation):

| Form | Syntax | Example |
|---|---|---|
| Keyword | `word` | `artbook` |
| Exact phrase | `"exact phrase"` | `"full color"` |
| Negation | `-word`, `-"exact phrase"`, `-field:value` | `-language:japanese` |
| Tag / field filter | `field:value` | `artist:example`, `language:english`, `tag:"big breasts"` |
| Numeric comparison | `field:>N`, `field:>=N`, `field:<N` | `pages:>10`, `favorites:>=100` |
| Relative date | `uploaded:<Nd`, `uploaded:>Nm` | `uploaded:<7d`, `uploaded:>1m` |

Combine terms with spaces (implicit AND). Filterable fields seen in the documentation include `artist`, `language`, `tag`, `pages`, `favorites`, and `uploaded`. Date suffixes are `d` (days) and `m` (months). URL-encode the whole query string.

Sorting is controlled separately by the `sort` parameter: `date`, `popular`, `popular-today`, `popular-week`, `popular-month`.

### C. Rate limit summary

Operations that declare limits, verbatim from the specification. Where multiple scopes are listed, all apply at once.

| Operation | Limits |
|---|---|
| [`GET /api/v2/galleries`](#get-apiv2galleries) | When `auth=anon`: • 15/1min per IP <br> When `auth=user\|key`: • 30/1min per IP |
| [`GET /api/v2/galleries/tagged`](#get-apiv2galleriestagged) | When `auth=anon`: • 15/1min per IP <br> When `auth=user\|key`: • 30/1min per IP |
| [`GET /api/v2/galleries/popular`](#get-apiv2galleriespopular) | 8/1min per IP |
| [`GET /api/v2/galleries/random`](#get-apiv2galleriesrandom) | When `auth=anon`: • 20/1min per IP <br> When `auth=user\|key`: • 30/1min per IP |
| [`GET /api/v2/galleries/{gallery_id}`](#get-apiv2galleriesgallery-id) | When `auth=anon`: • 20/1min per IP <br> When `auth=user\|key`: • 45/1min per IP |
| [`GET /api/v2/galleries/{gallery_id}/related`](#get-apiv2galleriesgallery-idrelated) | When `auth=anon`: • 12/1min per IP <br> When `auth=user\|key`: • 30/1min per IP |
| [`GET /api/v2/galleries/{gallery_id}/favorite`](#get-apiv2galleriesgallery-idfavorite) | 15/1min per user • 15/1min per API key owner |
| [`POST /api/v2/galleries/{gallery_id}/favorite`](#post-apiv2galleriesgallery-idfavorite) | 15/1min per user • 15/1min per API key owner • 15/1min per IP + user • 15/1min per IP + API key owner |
| [`DELETE /api/v2/galleries/{gallery_id}/favorite`](#delete-apiv2galleriesgallery-idfavorite) | 15/1min per user • 15/1min per API key owner • 15/1min per IP + user • 15/1min per IP + API key owner |
| [`POST /api/v2/galleries/{gallery_id}/download`](#post-apiv2galleriesgallery-iddownload) | When `format=torrent`: • 5/1min per IP • 10/5min per user • 5/1min per API key owner <br> When `format=zip\|cbz (default)`: • 10/5min per IP • 7/5min per user • 10/5min per API key owner |
| [`GET /api/v2/search`](#get-apiv2search) | When `auth=anon`: • 10/1min per IP <br> When `auth=user\|key`: • 20/1min per IP |
| [`GET /api/v2/tags/ids`](#get-apiv2tagsids) | 15/1min per IP |
| [`POST /api/v2/tags/search`](#post-apiv2tagssearch) | 30/1min per IP |
| [`GET /api/v2/tags/{tag_type}`](#get-apiv2tagstag-type) | When `auth=anon`: • 15/1min per IP <br> When `auth=user\|key`: • 30/1min per IP |
| [`GET /api/v2/tags/{tag_type}/{slug}`](#get-apiv2tagstag-typeslug) | When `auth=anon`: • 15/1min per IP <br> When `auth=user\|key`: • 30/1min per IP |
| [`GET /api/v2/galleries/{gallery_id}/comments`](#get-apiv2galleriesgallery-idcomments) | When `auth=anon`: • 30/1min per IP <br> When `auth=user\|key`: • 60/1min per IP |
| [`POST /api/v2/galleries/{gallery_id}/comments`](#post-apiv2galleriesgallery-idcomments) | 5/15min per user • 5/15min per IP + user • 10/15min per IP |
| [`GET /api/v2/galleries/{gallery_id}/comments/count`](#get-apiv2galleriesgallery-idcommentscount) | When `auth=anon`: • 12/1min per IP <br> When `auth=user\|key`: • 20/1min per IP |
| [`DELETE /api/v2/comments/{comment_id}`](#delete-apiv2commentscomment-id) | 5/15min per user • 5/15min per IP + user |
| [`POST /api/v2/comments/{comment_id}/flag`](#post-apiv2commentscomment-idflag) | 10/15min per user • 10/15min per IP + user • 15/15min per IP |
| [`GET /api/v2/favorites`](#get-apiv2favorites) | 15/1min per user • 15/1min per API key owner |
| [`GET /api/v2/favorites/random`](#get-apiv2favoritesrandom) | 15/1min per user • 15/1min per API key owner |
| [`GET /api/v2/blacklist`](#get-apiv2blacklist) | 15/1min per user • 15/1min per API key owner |
| [`POST /api/v2/blacklist`](#post-apiv2blacklist) | 20/15min per user • 20/15min per API key owner |
| [`GET /api/v2/blacklist/ids`](#get-apiv2blacklistids) | 45/1min per user |
| [`GET /api/v2/users/{user_id}/{slug}`](#get-apiv2usersuser-idslug) | When `auth=anon`: • 5/1min per IP <br> When `auth=user\|key`: • 10/1min per IP |
| [`GET /api/v2/user`](#get-apiv2user) | 45/1min per user • 45/1min per API key owner |
| [`PUT /api/v2/user`](#put-apiv2user) | 30/15min per user • 30/15min per IP + user |
| [`DELETE /api/v2/user`](#delete-apiv2user) | 3/1h per user • 3/1h per IP + user |
| [`POST /api/v2/user/avatar`](#post-apiv2useravatar) | 5/1min per user |
| [`GET /api/v2/user/keys`](#get-apiv2userkeys) | 30/1min per user |
| [`POST /api/v2/user/keys`](#post-apiv2userkeys) | 5/1h per user • 5/1h per IP + user |
| [`DELETE /api/v2/user/keys/{key_id}`](#delete-apiv2userkeyskey-id) | 10/1h per user • 10/1h per IP + user |
| [`POST /api/v2/auth/login`](#post-apiv2authlogin) | 10/15min per IP |
| [`POST /api/v2/auth/register`](#post-apiv2authregister) | 3/1h per IP |
| [`POST /api/v2/auth/refresh`](#post-apiv2authrefresh) | 15/15min per IP |
| [`POST /api/v2/auth/logout`](#post-apiv2authlogout) | 10/15min per user • 10/15min per IP + user |
| [`POST /api/v2/auth/logout/all`](#post-apiv2authlogoutall) | 5/1h per user • 5/1h per IP + user |
| [`GET /api/v2/auth/sessions`](#get-apiv2authsessions) | 30/1min per user |
| [`DELETE /api/v2/auth/sessions/{session_id}`](#delete-apiv2authsessionssession-id) | 10/1min per user |
| [`POST /api/v2/auth/reset`](#post-apiv2authreset) | 3/15min per IP |
| [`POST /api/v2/auth/reset/confirm`](#post-apiv2authresetconfirm) | 5/15min per IP |
| [`GET /api/v2/galleries/{gallery_id}/suggestions`](#get-apiv2galleriesgallery-idsuggestions) | 60/1min per IP |
| [`POST /api/v2/galleries/{gallery_id}/suggestions`](#post-apiv2galleriesgallery-idsuggestions) | 10/1h per user • 30/1h per IP |
| [`GET /api/v2/gts/backlog`](#get-apiv2gtsbacklog) | 60/1min per IP |
| [`GET /api/v2/gts/new-tags`](#get-apiv2gtsnew-tags) | 60/1min per IP |
| [`POST /api/v2/galleries/{gallery_id}/suggestions/{suggestion_id}/vote`](#post-apiv2galleriesgallery-idsuggestionssuggestion-idvote) | 80/1h per user • 240/1h per IP |
| [`DELETE /api/v2/galleries/{gallery_id}/suggestions/{suggestion_id}`](#delete-apiv2galleriesgallery-idsuggestionssuggestion-id) | 20/1h per user |
| [`GET /api/v2/moderation/gts`](#get-apiv2moderationgts) | 60/5min per user • 120/5min per IP |
| [`POST /api/v2/moderation/gts/{suggestion_id}/accept`](#post-apiv2moderationgtssuggestion-idaccept) | 30/15min per user • 60/15min per IP |
| [`POST /api/v2/moderation/gts/{suggestion_id}/reject`](#post-apiv2moderationgtssuggestion-idreject) | 30/15min per user • 60/15min per IP |
| [`POST /api/v2/moderation/gts/{suggestion_id}/revert`](#post-apiv2moderationgtssuggestion-idrevert) | 30/15min per user • 60/15min per IP |
| [`GET /api/v2/taxonomy`](#get-apiv2taxonomy) | 120/1min per IP |
| [`POST /api/v2/taxonomy`](#post-apiv2taxonomy) | 4/4h per user • 12/4h per IP |
| [`GET /api/v2/taxonomy/stats`](#get-apiv2taxonomystats) | 30/1min per IP |
| [`GET /api/v2/taxonomy/resolved`](#get-apiv2taxonomyresolved) | 90/1min per IP |
| [`GET /api/v2/taxonomy/{suggestion_id}`](#get-apiv2taxonomysuggestion-id) | 120/1min per IP |
| [`DELETE /api/v2/taxonomy/{suggestion_id}`](#delete-apiv2taxonomysuggestion-id) | 10/1h per user • 20/1h per IP |
| [`PATCH /api/v2/taxonomy/{suggestion_id}`](#patch-apiv2taxonomysuggestion-id) | 20/1h per user • 40/1h per IP |
| [`GET /api/v2/taxonomy/{suggestion_id}/comments`](#get-apiv2taxonomysuggestion-idcomments) | 120/1min per IP |
| [`POST /api/v2/taxonomy/{suggestion_id}/comments`](#post-apiv2taxonomysuggestion-idcomments) | 5/15min per user • 5/15min per IP + user • 10/15min per IP |
| [`DELETE /api/v2/taxonomy/{suggestion_id}/comments/{comment_id}`](#delete-apiv2taxonomysuggestion-idcommentscomment-id) | 30/15min per user • 60/15min per IP |
| [`POST /api/v2/taxonomy/{suggestion_id}/vote`](#post-apiv2taxonomysuggestion-idvote) | 30/1h per user • 60/1h per IP |
| [`GET /api/v2/taxonomy/{suggestion_id}/edits`](#get-apiv2taxonomysuggestion-idedits) | 120/1min per IP |
| [`POST /api/v2/moderation/taxonomy/{suggestion_id}/accept`](#post-apiv2moderationtaxonomysuggestion-idaccept) | 30/15min per user • 60/15min per IP |
| [`DELETE /api/v2/moderation/taxonomy/{suggestion_id}`](#delete-apiv2moderationtaxonomysuggestion-id) | 30/15min per user • 60/15min per IP |
| [`POST /api/v2/moderation/taxonomy/{suggestion_id}/reject`](#post-apiv2moderationtaxonomysuggestion-idreject) | 30/15min per user • 60/15min per IP |
| [`DELETE /api/v2/moderation/users/{user_id}`](#delete-apiv2moderationusersuser-id) | 10/15min per user |
| [`PUT /api/v2/moderation/users/{user_id}/shadowban`](#put-apiv2moderationusersuser-idshadowban) | 30/15min per user |
| [`DELETE /api/v2/moderation/users/{user_id}/shadowban`](#delete-apiv2moderationusersuser-idshadowban) | 30/15min per user |
| [`PUT /api/v2/moderation/galleries/{gallery_id}/hidden`](#put-apiv2moderationgalleriesgallery-idhidden) | 30/15min per user |
| [`DELETE /api/v2/moderation/galleries/{gallery_id}/hidden`](#delete-apiv2moderationgalleriesgallery-idhidden) | 30/15min per user |
| [`POST /api/v2/comments/flags/{flag_id}/review`](#post-apiv2commentsflagsflag-idreview) | 30/15min per user |
| [`POST /api/v2/moderation/edits/{edit_id}/vote`](#post-apiv2moderationeditsedit-idvote) | 30/15min per user |
| [`POST /api/v2/moderation/edits/{edit_id}/apply`](#post-apiv2moderationeditsedit-idapply) | 30/15min per user |
| [`POST /api/v2/moderation/edits/{edit_id}/reject`](#post-apiv2moderationeditsedit-idreject) | 30/15min per user |
| [`PUT /api/v2/moderation/comments/{comment_id}/hide`](#put-apiv2moderationcommentscomment-idhide) | 30/15min per user |
| [`DELETE /api/v2/moderation/comments/{comment_id}/hide`](#delete-apiv2moderationcommentscomment-idhide) | 30/15min per user |
| [`POST /api/v2/moderation/bulk/hide`](#post-apiv2moderationbulkhide) | 30/15min per user |
| [`POST /api/v2/moderation/bulk/unhide`](#post-apiv2moderationbulkunhide) | 30/15min per user |
| [`POST /api/v2/moderation/bulk/shadowban`](#post-apiv2moderationbulkshadowban) | 30/15min per user |
| [`POST /api/v2/moderation/bulk/unshadowban`](#post-apiv2moderationbulkunshadowban) | 30/15min per user |
| [`PUT /api/v2/moderation/spam/config/{name}`](#put-apiv2moderationspamconfigname) | 30/15min per user |

22 operations declare no explicit limit. Absence of a documented limit is not a guarantee of unlimited access — global abuse protections still apply.

### D. Schema index

| Schema | Type | Used by |
|---|---|---|
| [`Announcement`](#schema-announcement) | object (2 fields) | 0 operations |
| [`AnnouncementLink`](#schema-announcementlink) | object (2 fields) | 0 operations |
| [`ApiKeyCreateResponse`](#schema-apikeycreateresponse) | object (3 fields) | 1 operation |
| [`ApiKeyListItem`](#schema-apikeylistitem) | object (5 fields) | 1 operation |
| [`ApiRootResponse`](#schema-apirootresponse) | object (2 fields) | 1 operation |
| [`AutocompleteRequest`](#schema-autocompleterequest) | object (3 fields) | 1 operation |
| [`BacklogGallery`](#schema-backloggallery) | object (12 fields) | 0 operations |
| [`BacklogListResponse`](#schema-backloglistresponse) | object (4 fields) | 1 operation |
| [`BacklogRow`](#schema-backlogrow) | object (2 fields) | 0 operations |
| [`BlacklistListResponse`](#schema-blacklistlistresponse) | object (2 fields) | 1 operation |
| [`BlacklistResponse`](#schema-blacklistresponse) | object (2 fields) | 1 operation |
| [`BlacklistUpdateRequest`](#schema-blacklistupdaterequest) | object (2 fields) | 1 operation |
| [`BlacklistedTagResponse`](#schema-blacklistedtagresponse) | object (5 fields) | 0 operations |
| [`Body_confirm_password_reset_api_v2_auth_reset_confirm_post`](#schema-body-confirm-password-reset-api-v2-auth-reset-confirm-post) | object (5 fields) | 1 operation |
| [`Body_create_api_key_api_v2_user_keys_post`](#schema-body-create-api-key-api-v2-user-keys-post) | object (5 fields) | 1 operation |
| [`Body_create_comment_api_v2_galleries__gallery_id__comments_post`](#schema-body-create-comment-api-v2-galleries-gallery-id-comments-post) | object (4 fields) | 1 operation |
| [`Body_create_suggestion_api_v2_galleries__gallery_id__suggestions_post`](#schema-body-create-suggestion-api-v2-galleries-gallery-id-suggestions-post) | object (5 fields) | 1 operation |
| [`Body_create_taxonomy_comment_api_v2_taxonomy__suggestion_id__comments_post`](#schema-body-create-taxonomy-comment-api-v2-taxonomy-suggestion-id-comments-post) | object (4 fields) | 1 operation |
| [`Body_create_taxonomy_suggestion_api_v2_taxonomy_post`](#schema-body-create-taxonomy-suggestion-api-v2-taxonomy-post) | object (10 fields) | 1 operation |
| [`Body_edit_taxonomy_suggestion_api_v2_taxonomy__suggestion_id__patch`](#schema-body-edit-taxonomy-suggestion-api-v2-taxonomy-suggestion-id-patch) | object (8 fields) | 1 operation |
| [`Body_login_api_v2_auth_login_post`](#schema-body-login-api-v2-auth-login-post) | object (5 fields) | 1 operation |
| [`Body_logout_api_v2_auth_logout_post`](#schema-body-logout-api-v2-auth-logout-post) | object (1 fields) | 1 operation |
| [`Body_refresh_api_v2_auth_refresh_post`](#schema-body-refresh-api-v2-auth-refresh-post) | object (1 fields) | 1 operation |
| [`Body_register_api_v2_auth_register_post`](#schema-body-register-api-v2-auth-register-post) | object (6 fields) | 1 operation |
| [`Body_request_password_reset_api_v2_auth_reset_post`](#schema-body-request-password-reset-api-v2-auth-reset-post) | object (4 fields) | 1 operation |
| [`Body_update_spam_config_api_v2_moderation_spam_config__name__put`](#schema-body-update-spam-config-api-v2-moderation-spam-config-name-put) | object (1 fields) | 1 operation |
| [`Body_upload_avatar_api_v2_user_avatar_post`](#schema-body-upload-avatar-api-v2-user-avatar-post) | object (1 fields) | 1 operation |
| [`Body_vote_on_suggestion_api_v2_galleries__gallery_id__suggestions__suggestion_id__vote_post`](#schema-body-vote-on-suggestion-api-v2-galleries-gallery-id-suggestions-suggestion-id-vote-post) | object (3 fields) | 1 operation |
| [`Body_vote_on_taxonomy_suggestion_api_v2_taxonomy__suggestion_id__vote_post`](#schema-body-vote-on-taxonomy-suggestion-api-v2-taxonomy-suggestion-id-vote-post) | object (3 fields) | 1 operation |
| [`CaptchaErrorResponse`](#schema-captchaerrorresponse) | object (3 fields) | 4 operations |
| [`CaptchaInfoResponse`](#schema-captchainforesponse) | object (2 fields) | 1 operation |
| [`CdnConfigResponse`](#schema-cdnconfigresponse) | object (2 fields) | 1 operation |
| [`CommentResponse`](#schema-commentresponse) | object (5 fields) | 1 operation |
| [`ConfigResponse`](#schema-configresponse) | object (3 fields) | 1 operation |
| [`CoverInfo`](#schema-coverinfo) | object (3 fields) | 0 operations |
| [`CreateTagRequest`](#schema-createtagrequest) | object (2 fields) | 1 operation |
| [`CreatedTag`](#schema-createdtag) | object (2 fields) | 0 operations |
| [`CreatedTagResponse`](#schema-createdtagresponse) | object (5 fields) | 1 operation |
| [`CreativeSlot`](#schema-creativeslot) | object (3 fields) | 0 operations |
| [`DeleteProfileRequest`](#schema-deleteprofilerequest) | object (2 fields) | 1 operation |
| [`DeleteProfileResponse`](#schema-deleteprofileresponse) | object (2 fields) | 1 operation |
| [`DownloadResponse`](#schema-downloadresponse) | object (2 fields) | 1 operation |
| [`EditListResponse`](#schema-editlistresponse) | object (2 fields) | 1 operation |
| [`EditResponse`](#schema-editresponse) | object (13 fields) | 1 operation |
| [`EditTagInfo`](#schema-edittaginfo) | object (6 fields) | 0 operations |
| [`ErrorResponse`](#schema-errorresponse) | object (1 fields) | 95 operations |
| [`FavoriteResponse`](#schema-favoriteresponse) | object (2 fields) | 3 operations |
| [`FlagCommentRequest`](#schema-flagcommentrequest) | object (1 fields) | 1 operation |
| [`GalleryDetailResponse`](#schema-gallerydetailresponse) | object (16 fields) | 1 operation |
| [`GalleryLinkPreview`](#schema-gallerylinkpreview) | object (5 fields) | 0 operations |
| [`GalleryListItem`](#schema-gallerylistitem) | object (11 fields) | 1 operation |
| [`GallerySuggestionsBundle`](#schema-gallerysuggestionsbundle) | object (4 fields) | 0 operations |
| [`GalleryTitle`](#schema-gallerytitle) | object (3 fields) | 0 operations |
| [`HTTPValidationError`](#schema-httpvalidationerror) | object (1 fields) | 91 operations |
| [`HiddenGalleryResponse`](#schema-hiddengalleryresponse) | object (2 fields) | 2 operations |
| [`HtmlSlot`](#schema-htmlslot) | object (2 fields) | 0 operations |
| [`ModerationApiKeyItem`](#schema-moderationapikeyitem) | object (10 fields) | 0 operations |
| [`ModerationApiKeysListResponse`](#schema-moderationapikeyslistresponse) | object (5 fields) | 1 operation |
| [`ModerationCommentResponse`](#schema-moderationcommentresponse) | object (11 fields) | 0 operations |
| [`ModerationCommentsListResponse`](#schema-moderationcommentslistresponse) | object (5 fields) | 2 operations |
| [`ModerationFlagItem`](#schema-moderationflagitem) | object (16 fields) | 0 operations |
| [`ModerationFlagsListResponse`](#schema-moderationflagslistresponse) | object (5 fields) | 1 operation |
| [`ModerationGalleryInfo`](#schema-moderationgalleryinfo) | object (2 fields) | 1 operation |
| [`ModerationUserInfo`](#schema-moderationuserinfo) | object (3 fields) | 1 operation |
| [`NewTagIndexEntry`](#schema-newtagindexentry) | object (3 fields) | 0 operations |
| [`NewTagIndexResponse`](#schema-newtagindexresponse) | object (1 fields) | 1 operation |
| [`PageInfo`](#schema-pageinfo) | object (7 fields) | 0 operations |
| [`PaginatedResponse_CommentResponse_`](#schema-paginatedresponse-commentresponse-) | object (4 fields) | 1 operation |
| [`PaginatedResponse_GalleryListItem_`](#schema-paginatedresponse-gallerylistitem-) | object (4 fields) | 5 operations |
| [`PoWChallengeResponse`](#schema-powchallengeresponse) | object (2 fields) | 1 operation |
| [`PopunderInventoryResponse`](#schema-popunderinventoryresponse) | object (2 fields) | 1 operation |
| [`RecentComment`](#schema-recentcomment) | object (5 fields) | 0 operations |
| [`RecentFavorite`](#schema-recentfavorite) | object (9 fields) | 0 operations |
| [`RecordPopunderRequest`](#schema-recordpopunderrequest) | object (3 fields) | 1 operation |
| [`RecordPopunderResponse`](#schema-recordpopunderresponse) | object (1 fields) | 1 operation |
| [`RefreshResponse`](#schema-refreshresponse) | object (3 fields) | 1 operation |
| [`RelatedGalleriesResponse`](#schema-relatedgalleriesresponse) | object (1 fields) | 1 operation |
| [`ResolveSuggestionRequest`](#schema-resolvesuggestionrequest) | object (1 fields) | 2 operations |
| [`ResolveTaxonomySuggestionRequest`](#schema-resolvetaxonomysuggestionrequest) | object (3 fields) | 2 operations |
| [`ReviewFlagRequest`](#schema-reviewflagrequest) | object (1 fields) | 1 operation |
| [`ReviewFlagResponse`](#schema-reviewflagresponse) | object (2 fields) | 1 operation |
| [`SessionListItem`](#schema-sessionlistitem) | object (6 fields) | 1 operation |
| [`ShadowbanResponse`](#schema-shadowbanresponse) | object (1 fields) | 2 operations |
| [`SubmitEditRequest`](#schema-submiteditrequest) | object (3 fields) | 1 operation |
| [`SubmitEditResponse`](#schema-submiteditresponse) | object (3 fields) | 1 operation |
| [`SuccessResponse`](#schema-successresponse) | object (2 fields) | 18 operations |
| [`SuggestionListResponse`](#schema-suggestionlistresponse) | object (4 fields) | 2 operations |
| [`SuggestionProposer`](#schema-suggestionproposer) | object (4 fields) | 0 operations |
| [`SuggestionResponse`](#schema-suggestionresponse) | object (16 fields) | 2 operations |
| [`SuggestionTag`](#schema-suggestiontag) | object (6 fields) | 0 operations |
| [`SuggestionTierCounts`](#schema-suggestiontiercounts) | object (4 fields) | 0 operations |
| [`TagPaginatedResponse`](#schema-tagpaginatedresponse) | object (5 fields) | 1 operation |
| [`TagResponse`](#schema-tagresponse) | object (9 fields) | 3 operations |
| [`TaxonomyCommentAuthor`](#schema-taxonomycommentauthor) | object (6 fields) | 0 operations |
| [`TaxonomyCommentListResponse`](#schema-taxonomycommentlistresponse) | object (4 fields) | 1 operation |
| [`TaxonomyCommentResponse`](#schema-taxonomycommentresponse) | object (6 fields) | 1 operation |
| [`TaxonomyLinkPreview`](#schema-taxonomylinkpreview) | object (5 fields) | 0 operations |
| [`TaxonomySuggestionEditChange`](#schema-taxonomysuggestioneditchange) | object (3 fields) | 0 operations |
| [`TaxonomySuggestionEditEntry`](#schema-taxonomysuggestioneditentry) | object (5 fields) | 0 operations |
| [`TaxonomySuggestionEditListResponse`](#schema-taxonomysuggestioneditlistresponse) | object (1 fields) | 1 operation |
| [`TaxonomySuggestionListResponse`](#schema-taxonomysuggestionlistresponse) | object (4 fields) | 2 operations |
| [`TaxonomySuggestionProposer`](#schema-taxonomysuggestionproposer) | object (4 fields) | 0 operations |
| [`TaxonomySuggestionResolver`](#schema-taxonomysuggestionresolver) | object (4 fields) | 0 operations |
| [`TaxonomySuggestionResponse`](#schema-taxonomysuggestionresponse) | object (26 fields) | 4 operations |
| [`TaxonomySuggestionStats`](#schema-taxonomysuggestionstats) | object (13 fields) | 1 operation |
| [`TaxonomySuggestionTag`](#schema-taxonomysuggestiontag) | object (7 fields) | 0 operations |
| [`TokenResponse`](#schema-tokenresponse) | object (3 fields) | 2 operations |
| [`UpdateProfileRequest`](#schema-updateprofilerequest) | object (8 fields) | 1 operation |
| [`UpdateProfileResponse`](#schema-updateprofileresponse) | object (7 fields) | 1 operation |
| [`UserInfo`](#schema-userinfo) | object (7 fields) | 0 operations |
| [`UserMeResponse`](#schema-usermeresponse) | object (10 fields) | 1 operation |
| [`UserProfileResponse`](#schema-userprofileresponse) | object (11 fields) | 1 operation |
| [`UserPublic`](#schema-userpublic) | object (6 fields) | 0 operations |
| [`ValidationError`](#schema-validationerror) | object (5 fields) | 0 operations |
| [`VoteRequest`](#schema-voterequest) | object (1 fields) | 1 operation |
| [`VoteResponse`](#schema-voteresponse) | object (3 fields) | 1 operation |
| [`ZonesResponse`](#schema-zonesresponse) | object (1 fields) | 1 operation |

---

*Compiled from `openapi_documentation.json` and `API_-_Swagger_UI.html` (specification `2.0.0+71a8966`). Request/response examples are synthesized from schema definitions, not captured traffic. For the authoritative live specification see `GET /api/v2/openapi.json`; for changes see `/api/v2/changelog`.*
