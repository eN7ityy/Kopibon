# nhentai API Documentation

**Version:** 2.0.0+71a8966

nhentai.net REST API



Generate an API key in your [account settings](https://nhentai.net/user/settings#apikeys), then pass it as `Authorization: Key YOUR_API_KEY`.



Please set a descriptive `User-Agent` header: `AppName/version (contact or project URL)`. This helps us identify traffic and reach out if needed.



Questions or need higher limits? [support@nhentai.net](mailto:support@nhentai.net)



[Changelog](/api/v2/changelog)

---

## GET /api/v2

**Api Root**

API root.

—

**Auth:** Public (no authentication required)

---

## GET /api/v2/pow

**Get Pow Challenge**

Get a new proof of work challenge. Optionally specify action for per-action difficulty.

—

**Auth:** Public (no authentication required)

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| action | query | No | string | null |

---

## GET /api/v2/cdn

**Get Cdn Config**

Get CDN server configuration for media URLs.

—

**Auth:** Public (no authentication required)

---

## GET /api/v2/config

**Get Config**

Get app config: CDN servers and current announcement.

—

**Auth:** Public (no authentication required)

---

## GET /api/v2/captcha

**Get Captcha Info**

Get CAPTCHA provider info for the frontend widget.

—

**Auth:** Public (no authentication required)

---

## GET /api/v2/galleries

**Get All Galleries**

Get paginated galleries ordered by newest first.

—

**Auth:** Public (optional User Token or API Key for personalization)

**Rate limits:**

When `auth=anon`:
  - 15/1min per IP

When `auth=user|key`:
  - 30/1min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| page | query | No | integer |
| per_page | query | No | integer |

---

## GET /api/v2/galleries/tagged

**Get Galleries By Tag**

Get galleries with a specific tag.

—

**Auth:** Public (optional User Token or API Key for personalization)

**Rate limits:**

When `auth=anon`:
  - 15/1min per IP

When `auth=user|key`:
  - 30/1min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| tag_id | query | Yes | integer |
| sort | query | No | string |
| page | query | No | integer |
| per_page | query | No | integer |

---

## GET /api/v2/galleries/popular

**Get Popular Galleries**

Get today's popular galleries.

—

**Auth:** Public (optional User Token or API Key for personalization)

**Rate limits:**
- 8/1min per IP

---

## GET /api/v2/galleries/random

**Get Random Gallery**

Get a random gallery ID.

—

**Auth:** Public (optional User Token or API Key for personalization)

**Rate limits:**

When `auth=anon`:
  - 20/1min per IP

When `auth=user|key`:
  - 30/1min per IP

---

## GET /api/v2/galleries/{gallery_id}

**Get Gallery**

Get a single gallery with full details and optional includes.

—

**Auth:** Public (optional User Token or API Key for personalization)

**Rate limits:**

When `auth=anon`:
  - 20/1min per IP

When `auth=user|key`:
  - 45/1min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| gallery_id | path | Yes | integer |
| include | query | No | string |

---

## GET /api/v2/galleries/{gallery_id}/related

**Get Related Galleries**

Get galleries similar to the specified gallery.

—

**Auth:** Public (optional User Token or API Key for personalization)

**Rate limits:**

When `auth=anon`:
  - 12/1min per IP

When `auth=user|key`:
  - 30/1min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| gallery_id | path | Yes | integer |

---

## GET /api/v2/galleries/{gallery_id}/favorite

**Check Favorite**

Check if a gallery is in the user's favorites.

—

**Auth:** User Token or API Key

**Rate limits:**
- 15/1min per user
- 15/1min per API key owner

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| gallery_id | path | Yes | integer |

---

## POST /api/v2/galleries/{gallery_id}/favorite

**Add To Favorites**

Add a gallery to the current user's favorites.

—

**Auth:** User Token or API Key

**Feature Flag:** `allow_favorites` must be enabled

**Rate limits:**
- 15/1min per user
- 15/1min per API key owner
- 15/1min per IP + user
- 15/1min per IP + API key owner

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| gallery_id | path | Yes | integer |

---

## DELETE /api/v2/galleries/{gallery_id}/favorite

**Remove From Favorites**

Remove a gallery from the current user's favorites.

—

**Auth:** User Token or API Key

**Feature Flag:** `allow_favorites` must be enabled

**Rate limits:**
- 15/1min per user
- 15/1min per API key owner
- 15/1min per IP + user
- 15/1min per IP + API key owner

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| gallery_id | path | Yes | integer |

---

## POST /api/v2/galleries/{gallery_id}/edit

**Submit Gallery Edit**

Retired. Tag changes go through the suggestion flow now.

—

**Auth:** Staff Token required

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| gallery_id | path | Yes | integer |

---

## GET /api/v2/galleries/{gallery_id}/suggestions

**List Gallery Suggestions**

List current tag-change proposals on a gallery.

—

**Auth:** Public (optional User Token or API Key for personalization)

**Feature Flag:** `allow_gts` must be enabled

**Rate limits:**
- 60/1min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| gallery_id | path | Yes | integer |
| tier | query | No | string |
| limit | query | No | integer |

---

## POST /api/v2/galleries/{gallery_id}/suggestions

**Create Suggestion**

Propose adding or removing a tag on a gallery.

If a matching proposal already exists, your call adds your vote to it
instead of creating a duplicate.

—

**Auth:** User Token required

**Feature Flag:** `allow_gts` must be enabled

**Protection:** Proof of Work required (`GET /api/v2/pow?action=gts_create`)

**Protection:** CAPTCHA required (`GET /api/v2/captcha` for provider info)

**Rate limits:**
- 10/1h per user
- 30/1h per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| gallery_id | path | Yes | integer |

---

## GET /api/v2/gts/backlog

**List Gts Backlog**

List pending tag-change suggestions across galleries.

—

**Auth:** Public (optional User Token or API Key for personalization)

**Feature Flag:** `allow_gts` must be enabled

**Rate limits:**
- 60/1min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| page | query | No | integer |
| per_page | query | No | integer |
| tag_id | query | No | integer | null |
| action | query | No | string | null |
| sort_by | query | No | string |
| sort | query | No | string |

---

## GET /api/v2/gts/new-tags

**List New Tag Index**

List the most recently community-minted tags.

—

**Auth:** Public (no authentication required)

**Feature Flag:** `allow_gts` must be enabled

**Rate limits:**
- 60/1min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| limit | query | No | integer |

---

## POST /api/v2/galleries/{gallery_id}/suggestions/{suggestion_id}/vote

**Vote On Suggestion**

Up/down vote on a suggestion. Pass vote=0 to clear your vote.

—

**Auth:** User Token required

**Feature Flag:** `allow_gts` must be enabled

**Protection:** Proof of Work required (`GET /api/v2/pow?action=gts_vote`)

**Rate limits:**
- 80/1h per user
- 240/1h per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| gallery_id | path | Yes | integer |
| suggestion_id | path | Yes | string |

---

## DELETE /api/v2/galleries/{gallery_id}/suggestions/{suggestion_id}

**Withdraw Suggestion**

Proposer withdraws their own pending suggestion.

—

**Auth:** User Token required

**Feature Flag:** `allow_gts` must be enabled

**Rate limits:**
- 20/1h per user

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| gallery_id | path | Yes | integer |
| suggestion_id | path | Yes | string |

---

## GET /api/v2/moderation/gts

**List Pending Suggestions**

Mod queue: proposals awaiting staff review, or recently resolved.

—

**Auth:** Staff Token required

**Rate limits:**
- 60/5min per user
- 120/5min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| status | query | No | string |
| q | query | No | string | null |
| sort | query | No | string |
| tag_type | query | No | string | null |
| page | query | No | integer |
| per_page | query | No | integer |

---

## POST /api/v2/moderation/gts/{suggestion_id}/accept

**Accept Suggestion**

Apply a pending suggestion to the gallery and mark accepted.

—

**Auth:** Staff Token required

**Rate limits:**
- 30/15min per user
- 60/15min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| suggestion_id | path | Yes | string |

---

## POST /api/v2/moderation/gts/{suggestion_id}/reject

**Reject Suggestion**

Reject a pending suggestion without applying it.

—

**Auth:** Staff Token required

**Rate limits:**
- 30/15min per user
- 60/15min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| suggestion_id | path | Yes | string |

---

## POST /api/v2/moderation/gts/{suggestion_id}/revert

**Revert Suggestion**

Undo the tag mutation of a previously accepted suggestion.

—

**Auth:** Staff Token required

**Rate limits:**
- 30/15min per user
- 60/15min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| suggestion_id | path | Yes | string |

---

## POST /api/v2/moderation/tags

**Moderation Create Tag**

Create a new tag. Slug is derived from `name`.

—

**Auth:** Staff Token required

---

## POST /api/v2/galleries/{gallery_id}/download

**Get a download URL for a gallery**

Returns a short-lived URL for the gallery as a zip, cbz, or torrent
file. Fetch `url` before `expires_at` (unix timestamp).

—

**Auth:** User Token or API Key

**Feature Flag:** `allow_downloads` must be enabled

**Rate limits:**

When `format=torrent`:
  - 5/1min per IP
  - 10/5min per user
  - 5/1min per API key owner

When `format=zip|cbz (default)`:
  - 10/5min per IP
  - 7/5min per user
  - 10/5min per API key owner

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| gallery_id | path | Yes | integer |
| format | query | No | string |

---

## GET /api/v2/tags/ids

**Get Tags By Ids**

Look up multiple tags by ID. Max 100 per request.

—

**Auth:** Public (no authentication required)

**Rate limits:**
- 15/1min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| ids | query | Yes | string |

---

## POST /api/v2/tags/search

**Search Tags**

Search tags by name prefix. Omit `type` to search across all tag types.

—

**Auth:** Public (no authentication required)

**Rate limits:**
- 30/1min per IP

---

## GET /api/v2/tags/{tag_type}

**Get Tags By Type**

Get tags of a specific type with pagination.

Supports both page-based and cursor-based pagination.

—

**Auth:** Public (no authentication required)

**Rate limits:**

When `auth=anon`:
  - 15/1min per IP

When `auth=user|key`:
  - 30/1min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| tag_type | path | Yes | string |
| sort | query | No | string |
| page | query | No | integer |
| per_page | query | No | integer |

---

## GET /api/v2/tags/{tag_type}/{slug}

**Get Tag By Slug**

Get a specific tag by type and slug.

—

**Auth:** Public (no authentication required)

**Rate limits:**

When `auth=anon`:
  - 15/1min per IP

When `auth=user|key`:
  - 30/1min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| tag_type | path | Yes | string |
| slug | path | Yes | string |

---

## GET /api/v2/taxonomy

**List Taxonomy Suggestions**

List pending tag suggestions.

—

**Auth:** Public (optional User Token or API Key for personalization)

**Feature Flag:** `allow_taxonomy` must be enabled

**Rate limits:**
- 120/1min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| tier | query | No | string |
| page | query | No | integer |
| per_page | query | No | integer |
| q | query | No | string | null |
| target_tag_id | query | No | integer | null |
| sort_by | query | No | string |
| sort | query | No | string |
| action | query | No | string | null |
| discussion | query | No | string | null |
| edited | query | No | string | null |

---

## POST /api/v2/taxonomy

**Create Taxonomy Suggestion**

Submit a tag suggestion.

—

**Auth:** User Token required

**Feature Flag:** `allow_taxonomy` must be enabled

**Protection:** Proof of Work required (`GET /api/v2/pow?action=taxonomy_create`)

**Protection:** CAPTCHA required (`GET /api/v2/captcha` for provider info)

**Rate limits:**
- 4/4h per user
- 12/4h per IP

---

## GET /api/v2/taxonomy/stats

**Get Taxonomy Suggestion Stats**

Taxonomy activity summary: pending count + recently-accepted suggestions.

—

**Auth:** Public (no authentication required)

**Feature Flag:** `allow_taxonomy` must be enabled

**Rate limits:**
- 30/1min per IP

---

## GET /api/v2/taxonomy/resolved

**List Resolved Taxonomy Suggestions**

List resolved tag suggestions.

—

**Auth:** Public (optional User Token or API Key for personalization)

**Feature Flag:** `allow_taxonomy` must be enabled

**Rate limits:**
- 90/1min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| status | query | No | string |
| q | query | No | string | null |
| discussion | query | No | string | null |
| edited | query | No | string | null |
| action | query | No | string | null |
| sort_by | query | No | string |
| sort | query | No | string |
| page | query | No | integer |
| per_page | query | No | integer |

---

## GET /api/v2/taxonomy/{suggestion_id}

**Get Taxonomy Suggestion**

Fetch a tag suggestion with its latest comment preview.

—

**Auth:** Public (optional User Token or API Key for personalization)

**Feature Flag:** `allow_taxonomy` must be enabled

**Rate limits:**
- 120/1min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| suggestion_id | path | Yes | string |

---

## DELETE /api/v2/taxonomy/{suggestion_id}

**Remove Taxonomy Suggestion**

Delete your own pending tag suggestion.

—

**Auth:** User Token required

**Feature Flag:** `allow_taxonomy` must be enabled

**Rate limits:**
- 10/1h per user
- 20/1h per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| suggestion_id | path | Yes | string |

---

## PATCH /api/v2/taxonomy/{suggestion_id}

**Edit Taxonomy Suggestion**

Edit a pending tag suggestion.

—

**Auth:** User Token required

**Feature Flag:** `allow_taxonomy` must be enabled

**Rate limits:**
- 20/1h per user
- 40/1h per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| suggestion_id | path | Yes | string |

---

## GET /api/v2/taxonomy/{suggestion_id}/comments

**List Taxonomy Comments**

List comments on a tag suggestion.

—

**Auth:** Public (optional User Token or API Key for personalization)

**Feature Flag:** `allow_taxonomy` must be enabled

**Rate limits:**
- 120/1min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| suggestion_id | path | Yes | string |
| page | query | No | integer |
| per_page | query | No | integer |

---

## POST /api/v2/taxonomy/{suggestion_id}/comments

**Create Taxonomy Comment**

Post a comment on a tag suggestion.

—

**Auth:** User Token required

**Feature Flag:** `allow_taxonomy` must be enabled

**Protection:** Proof of Work required (`GET /api/v2/pow?action=taxonomy_comment`)

**Protection:** CAPTCHA required (`GET /api/v2/captcha` for provider info)

**Rate limits:**
- 5/15min per user
- 5/15min per IP + user
- 10/15min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| suggestion_id | path | Yes | string |

---

## DELETE /api/v2/taxonomy/{suggestion_id}/comments/{comment_id}

**Delete Taxonomy Comment**

Delete a comment. Authors can delete their own; moderators can delete any.

—

**Auth:** User Token required

**Feature Flag:** `allow_taxonomy` must be enabled

**Rate limits:**
- 30/15min per user
- 60/15min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| suggestion_id | path | Yes | string |
| comment_id | path | Yes | string |

---

## POST /api/v2/taxonomy/{suggestion_id}/vote

**Vote On Taxonomy Suggestion**

Vote on a tag suggestion. Pass vote=0 to clear.

—

**Auth:** User Token required

**Feature Flag:** `allow_taxonomy` must be enabled

**Protection:** Proof of Work required (`GET /api/v2/pow?action=taxonomy_vote`)

**Rate limits:**
- 30/1h per user
- 60/1h per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| suggestion_id | path | Yes | string |

---

## GET /api/v2/taxonomy/{suggestion_id}/edits

**List Taxonomy Edits**

List a suggestion's edit history.

—

**Auth:** Public (no authentication required)

**Feature Flag:** `allow_taxonomy` must be enabled

**Rate limits:**
- 120/1min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| suggestion_id | path | Yes | string |

---

## POST /api/v2/moderation/taxonomy/{suggestion_id}/accept

**Accept Taxonomy Suggestion**

Accept a tag suggestion.

—

**Auth:** Staff Token required

**Rate limits:**
- 30/15min per user
- 60/15min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| suggestion_id | path | Yes | string |

---

## DELETE /api/v2/moderation/taxonomy/{suggestion_id}

**Delete Taxonomy Suggestion**

Permanently remove a tag suggestion. Reserved for spam and abuse.

—

**Auth:** Superuser Token required

**Feature Flag:** `allow_taxonomy` must be enabled

**Rate limits:**
- 30/15min per user
- 60/15min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| suggestion_id | path | Yes | string |

---

## POST /api/v2/moderation/taxonomy/{suggestion_id}/reject

**Reject Taxonomy Suggestion**

Reject a tag suggestion.

—

**Auth:** Staff Token required

**Rate limits:**
- 30/15min per user
- 60/15min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| suggestion_id | path | Yes | string |

---

## GET /api/v2/galleries/{gallery_id}/comments

**Get Gallery Comments**

Paginated list of visible comments on a gallery, newest first.

—

**Auth:** Public (optional User Token or API Key for personalization)

**Rate limits:**

When `auth=anon`:
  - 30/1min per IP

When `auth=user|key`:
  - 60/1min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| gallery_id | path | Yes | integer |
| page | query | No | integer |
| per_page | query | No | integer |

---

## POST /api/v2/galleries/{gallery_id}/comments

**Create Comment**

Create a new comment on a gallery.

—

**Auth:** User Token required

**Feature Flag:** `allow_comments` must be enabled

**Protection:** Proof of Work required (`GET /api/v2/pow?action=comment`)

**Protection:** CAPTCHA required (`GET /api/v2/captcha` for provider info)

**Rate limits:**
- 5/15min per user
- 5/15min per IP + user
- 10/15min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| gallery_id | path | Yes | integer |

---

## GET /api/v2/galleries/{gallery_id}/comments/count

**Get Gallery Comment Count**

Get the visible comment count for a gallery.

—

**Auth:** Public (no authentication required)

**Rate limits:**

When `auth=anon`:
  - 12/1min per IP

When `auth=user|key`:
  - 20/1min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| gallery_id | path | Yes | integer |

---

## DELETE /api/v2/comments/{comment_id}

**Delete Comment**

Delete a comment.

Only the comment owner or staff can delete comments.

—

**Auth:** User Token required

**Feature Flag:** `allow_comments` must be enabled

**Rate limits:**
- 5/15min per user
- 5/15min per IP + user

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| comment_id | path | Yes | integer |

---

## POST /api/v2/comments/{comment_id}/flag

**Flag Comment**

Flag a comment for review.

—

**Auth:** User Token required

**Rate limits:**
- 10/15min per user
- 10/15min per IP + user
- 15/15min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| comment_id | path | Yes | integer |

---

## GET /api/v2/search

**Search Galleries**

Search galleries.

Supports:
- Keywords: `word`
- Exact phrases: `"exact phrase"`
- Negation: `-word`, `-"exact phrase"`, `-artist:name`
- Tag filters: `artist:name`, `language:english`, `tag:"big breasts"`
- Numeric filters: `pages:>10`, `favorites:>=100`
- Date filters: `uploaded:<7d`, `uploaded:>1m`

—

**Auth:** Public (optional User Token or API Key for personalization)

**Rate limits:**

When `auth=anon`:
  - 10/1min per IP

When `auth=user|key`:
  - 20/1min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| query | query | Yes | string |
| sort | query | No | string |
| page | query | No | integer |

---

## GET /api/v2/user

**Get Me**

Get your profile info. Email is hidden for API key auth.

—

**Auth:** User Token or API Key

**Rate limits:**
- 45/1min per user
- 45/1min per API key owner

---

## PUT /api/v2/user

**Update Profile**

Update your profile.

—

**Auth:** User Token required

**Rate limits:**
- 30/15min per user
- 30/15min per IP + user

---

## DELETE /api/v2/user

**Delete Account**

Delete your account. Requires password and username confirmation.

—

**Auth:** User Token required

**Rate limits:**
- 3/1h per user
- 3/1h per IP + user

---

## POST /api/v2/user/avatar

**Upload Avatar**

Upload a new avatar image.

Accepts JPEG, PNG, GIF, or WebP up to 10 MB. The image is converted to
PNG and resized to fit within 200x200 pixels. Returns the new avatar URL.

—

**Auth:** User Token required

**Rate limits:**
- 5/1min per user

---

## GET /api/v2/user/keys

**List Api Keys**

List your API keys.

—

**Auth:** User Token required

**Rate limits:**
- 30/1min per user

---

## POST /api/v2/user/keys

**Create Api Key**

Create a new API key. The raw key is only shown once.

—

**Auth:** User Token required

**Feature Flag:** `allow_api_keys` must be enabled

**Protection:** Proof of Work required (`GET /api/v2/pow?action=api_key`)

**Protection:** CAPTCHA required (`GET /api/v2/captcha` for provider info)

**Rate limits:**
- 5/1h per user
- 5/1h per IP + user

---

## DELETE /api/v2/user/keys/{key_id}

**Revoke Api Key**

Revoke an API key.

—

**Auth:** User Token required

**Feature Flag:** `allow_api_keys` must be enabled

**Rate limits:**
- 10/1h per user
- 10/1h per IP + user

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| key_id | path | Yes | string |

---

## GET /api/v2/favorites

**Get Favorites**

Get the authenticated user's favorite galleries.

—

**Auth:** User Token or API Key

**Rate limits:**
- 15/1min per user
- 15/1min per API key owner

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| q | query | No | string | null |
| page | query | No | integer |

---

## GET /api/v2/favorites/random

**Get Random Favorite**

Get a random gallery ID from the authenticated user's favorites.

—

**Auth:** User Token or API Key

**Rate limits:**
- 15/1min per user
- 15/1min per API key owner

---

## GET /api/v2/blacklist

**Get Blacklist**

Get the authenticated user's blacklisted tags.

—

**Auth:** User Token or API Key

**Rate limits:**
- 15/1min per user
- 15/1min per API key owner

---

## POST /api/v2/blacklist

**Update Blacklist**

Add or remove tags from the authenticated user's blacklist.

—

**Auth:** User Token or API Key

**Rate limits:**
- 20/15min per user
- 20/15min per API key owner

---

## GET /api/v2/blacklist/ids

**Get Blacklist Ids**

Get just the tag IDs for the authenticated user's blacklist.

—

**Auth:** User Token or API Key

**Rate limits:**
- 45/1min per user

---

## GET /api/v2/users/{user_id}/{slug}

**Get User Profile**

Get a user's public profile.

Requires both the user ID and correct username slug.

—

**Auth:** Public (optional User Token or API Key for personalization)

**Rate limits:**

When `auth=anon`:
  - 5/1min per IP

When `auth=user|key`:
  - 10/1min per IP

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| user_id | path | Yes | integer |
| slug | path | Yes | string |

---

## POST /api/v2/auth/login

**Login**

Authenticate with username/email and password.

Returns access token and refresh token.

—

**Auth:** Public (no authentication required)

**Protection:** Proof of Work required (`GET /api/v2/pow?action=login`)

**Protection:** CAPTCHA required (`GET /api/v2/captcha` for provider info)

**Rate limits:**
- 10/15min per IP

---

## POST /api/v2/auth/register

**Register**

Create a new account.

Returns access token and refresh token.

—

**Auth:** Public (no authentication required)

**Feature Flag:** `allow_register` must be enabled

**Protection:** Proof of Work required (`GET /api/v2/pow?action=register`)

**Protection:** CAPTCHA required (`GET /api/v2/captcha` for provider info)

**Rate limits:**
- 3/1h per IP

---

## POST /api/v2/auth/refresh

**Refresh**

Exchange a refresh token for new access + refresh tokens.

The old refresh token is revoked (token rotation).

—

**Auth:** Public (no authentication required)

**Rate limits:**
- 15/15min per IP

---

## POST /api/v2/auth/logout

**Logout**

Revoke the refresh token.

—

**Auth:** User Token required

**Rate limits:**
- 10/15min per user
- 10/15min per IP + user

---

## POST /api/v2/auth/logout/all

**Logout All**

Revoke all sessions for the current user (log out everywhere).

—

**Auth:** User Token required

**Rate limits:**
- 5/1h per user
- 5/1h per IP + user

---

## GET /api/v2/auth/sessions

**Get Sessions**

List all active sessions for the current user.

—

**Auth:** User Token required

**Rate limits:**
- 30/1min per user

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| x-refresh-token | header | No | string | null |

---

## DELETE /api/v2/auth/sessions/{session_id}

**Revoke Session**

Revoke a specific session by ID.

—

**Auth:** User Token required

**Rate limits:**
- 10/1min per user

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| session_id | path | Yes | string |

---

## POST /api/v2/auth/reset

**Request Password Reset**

Request a password reset.

Sends a reset link to the user's email if the account exists.

—

**Auth:** Public (no authentication required)

**Feature Flag:** `allow_password_reset` must be enabled

**Protection:** Proof of Work required (`GET /api/v2/pow?action=reset`)

**Protection:** CAPTCHA required (`GET /api/v2/captcha` for provider info)

**Rate limits:**
- 3/15min per IP

---

## POST /api/v2/auth/reset/confirm

**Confirm Password Reset**

Confirm a password reset with the token from the reset email.

—

**Auth:** Public (no authentication required)

**Feature Flag:** `allow_password_reset` must be enabled

**Protection:** Proof of Work required (`GET /api/v2/pow?action=reset`)

**Protection:** CAPTCHA required (`GET /api/v2/captcha` for provider info)

**Rate limits:**
- 5/15min per IP

---

## GET /api/v2/moderation/users/{user_id}

**Get User Mod Info**

Get moderation info for a user. Staff sees shadowban, admins also see email.

—

**Auth:** Staff Token required

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| user_id | path | Yes | integer |

---

## DELETE /api/v2/moderation/users/{user_id}

**Delete User**

Delete a user account. Cascades user-owned content. Staff only.

—

**Auth:** Staff Token required

**Rate limits:**
- 10/15min per user

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| user_id | path | Yes | integer |

---

## PUT /api/v2/moderation/users/{user_id}/shadowban

**Shadowban User**

Shadowban a user. Staff only.

—

**Auth:** Staff Token required

**Rate limits:**
- 30/15min per user

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| user_id | path | Yes | integer |

---

## DELETE /api/v2/moderation/users/{user_id}/shadowban

**Unshadowban User**

Remove shadowban from a user. Staff only.

—

**Auth:** Staff Token required

**Rate limits:**
- 30/15min per user

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| user_id | path | Yes | integer |

---

## GET /api/v2/moderation/galleries/hidden

**List Hidden Galleries**

List hidden galleries newest-first.

—

**Auth:** Staff Token required

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| page | query | No | integer |
| per_page | query | No | integer |

---

## GET /api/v2/moderation/galleries/{gallery_id}

**Get Gallery Mod Info**

Get moderation status for a gallery.

—

**Auth:** Staff Token required

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| gallery_id | path | Yes | integer |

---

## PUT /api/v2/moderation/galleries/{gallery_id}/hidden

**Hide Gallery**

Hide a gallery from public reads. Staff only.

—

**Auth:** Staff Token required

**Rate limits:**
- 30/15min per user

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| gallery_id | path | Yes | integer |

---

## DELETE /api/v2/moderation/galleries/{gallery_id}/hidden

**Unhide Gallery**

Reveal a previously-hidden gallery. Staff only.

—

**Auth:** Staff Token required

**Rate limits:**
- 30/15min per user

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| gallery_id | path | Yes | integer |

---

## POST /api/v2/comments/flags/{flag_id}/review

**Review Comment Flag**

Review a comment flag.

Actions:
- approve: Accept the flag and hide the comment
- reject: Reject the flag, no action taken

Staff only.

—

**Auth:** Staff Token required

**Rate limits:**
- 30/15min per user

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| flag_id | path | Yes | integer |

---

## GET /api/v2/moderation/flags

**Get Pending Flags**

Get pending (unreviewed) comment flags. Staff only.

—

**Auth:** Staff Token required

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| page | query | No | integer |
| per_page | query | No | integer |
| q | query | No | string | null |
| hide_shadowbanned | query | No | boolean |

---

## GET /api/v2/moderation/edits

**Get Pending Edits**

Retired. Tag changes go through the suggestion flow now.

—

**Auth:** Staff Token required

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| limit | query | No | integer |

---

## GET /api/v2/moderation/edits/{edit_id}

**Get Edit**

Retired. Tag changes go through the suggestion flow now.

—

**Auth:** Staff Token required

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| edit_id | path | Yes | integer |

---

## POST /api/v2/moderation/edits/{edit_id}/vote

**Vote On Edit**

Retired. Tag changes go through the suggestion flow now.

—

**Auth:** Staff Token required

**Rate limits:**
- 30/15min per user

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| edit_id | path | Yes | integer |

---

## POST /api/v2/moderation/edits/{edit_id}/apply

**Apply Edit**

Retired. Tag changes go through the suggestion flow now.

—

**Auth:** Staff Token required

**Rate limits:**
- 30/15min per user

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| edit_id | path | Yes | integer |

---

## POST /api/v2/moderation/edits/{edit_id}/reject

**Reject Edit**

Retired. Tag changes go through the suggestion flow now.

—

**Auth:** Staff Token required

**Rate limits:**
- 30/15min per user

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| edit_id | path | Yes | integer |

---

## GET /api/v2/moderation/comments/recent

**Get Recent Comments**

Get recent visible comments. Admin only.

—

**Auth:** Superuser Token required

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| page | query | No | integer |
| per_page | query | No | integer |
| q | query | No | string | null |

---

## GET /api/v2/moderation/comments/spam

**Get Spam Comments**

Get spam/hidden comments. Admin only.

—

**Auth:** Superuser Token required

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| page | query | No | integer |
| per_page | query | No | integer |
| q | query | No | string | null |

---

## PUT /api/v2/moderation/comments/{comment_id}/hide

**Hide Comment**

Hide a comment. Staff only.

—

**Auth:** Staff Token required

**Rate limits:**
- 30/15min per user

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| comment_id | path | Yes | integer |

---

## DELETE /api/v2/moderation/comments/{comment_id}/hide

**Unhide Comment**

Unhide a comment. Staff only.

—

**Auth:** Staff Token required

**Rate limits:**
- 30/15min per user

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| comment_id | path | Yes | integer |

---

## POST /api/v2/moderation/bulk/hide

**Bulk Hide**

Hide multiple comments. Staff only.

—

**Auth:** Staff Token required

**Rate limits:**
- 30/15min per user

---

## POST /api/v2/moderation/bulk/unhide

**Bulk Unhide**

Unhide multiple comments. Staff only.

—

**Auth:** Staff Token required

**Rate limits:**
- 30/15min per user

---

## POST /api/v2/moderation/bulk/shadowban

**Bulk Shadowban**

Shadowban multiple users. Staff only.

—

**Auth:** Staff Token required

**Rate limits:**
- 30/15min per user

---

## POST /api/v2/moderation/bulk/unshadowban

**Bulk Unshadowban**

Unshadowban multiple users. Staff only.

—

**Auth:** Staff Token required

**Rate limits:**
- 30/15min per user

---

## GET /api/v2/moderation/api-keys

**List All Api Keys**

List all active API keys with user info. Admin only.

—

**Auth:** Superuser Token required

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| page | query | No | integer |
| per_page | query | No | integer |
| sort | query | No | string |
| has_purpose | query | No | boolean | null |
| q | query | No | string |
| key_id | query | No | string | null |

---

## DELETE /api/v2/moderation/api-keys/{key_id}

**Revoke Api Key Admin**

Revoke any API key. Admin only.

—

**Auth:** Superuser Token required

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| key_id | path | Yes | string |

---

## GET /api/v2/moderation/spam/config

**Get Spam Config**

Staff only.

—

**Auth:** Staff Token required

---

## PUT /api/v2/moderation/spam/config/{name}

**Update Spam Config**

Staff only.

—

**Auth:** Staff Token required

**Rate limits:**
- 30/15min per user

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| name | path | Yes | string |

---

## GET /api/v2/zones

**Get Zones**

Slot instructions for this request: HTML for paid inventory, named
creatives for house ads. Missing keys = empty slots. House creatives
are gated per-creative on CF-IPCountry.

—

**Auth:** Public (no authentication required)

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| user-agent | header | No | string |
| cf-ipcountry | header | No | string |

---

## GET /api/v2/zones/i

**Get Popunder Inventory**

Get available popunder for current user.

Returns the next popunder to show with timing info.
delta is in milliseconds (0 means ready to show).

—

**Auth:** Public (no authentication required)

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| user-agent | header | No | string |
| cf-ipcountry | header | No | string |
| tor_session | cookie | No | string | null |

---

## POST /api/v2/zones/h

**Record Popunder Hit**

Record a popunder impression/open event.

Called by frontend when a popunder is triggered.

—

**Auth:** Public (no authentication required)

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| user-agent | header | No | string |
| tor_session | cookie | No | string | null |

---

## GET /api/v2/zones/pu

**Popunder Redirect**

Redirect to popunder ad URL.

Two-step process:
1. First call (without out=1): records "opens" stat, redirects to self with out=1
2. Second call (with out=1): records "redirects" stat, redirects to actual URL

This allows tracking of both opens and actual redirects.

—

**Auth:** Public (no authentication required)

| Parameter | Location | Required | Type |
|-----------|----------|----------|------|
| name | query | Yes | string |
| out | query | No | string | null |
| user-agent | header | No | string |
| tor_session | cookie | No | string | null |

---
# Schemas

## Announcement

| Field | Type | Required |
|-------|------|----------|
| message | string | Yes |
| links | array | No |

---

## AnnouncementLink

| Field | Type | Required |
|-------|------|----------|
| text | string | Yes |
| url | string | Yes |

---

## ApiKeyCreateResponse

| Field | Type | Required |
|-------|------|----------|
| id | string | Yes |
| key | string | Yes |
| name | string | Yes |

---

## ApiKeyListItem

| Field | Type | Required |
|-------|------|----------|
| id | string | Yes |
| key_prefix | string | Yes |
| name | string | Yes |
| created_at | integer | Yes |
| last_used_at |  | No |

---

## ApiRootResponse

| Field | Type | Required |
|-------|------|----------|
| version | string | Yes |
| message | string | Yes |

---

## AutocompleteRequest

| Field | Type | Required |
|-------|------|----------|
| type |  | No |
| query |  | No |
| limit | integer | No |

---

## BacklogGallery

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| media_id | string | Yes |
| thumbnail | string | Yes |
| thumbnail_width | integer | Yes |
| thumbnail_height | integer | Yes |
| english_title | string | Yes |
| japanese_title |  | No |
| num_pages | integer | Yes |
| num_favorites | integer | Yes |
| upload_date | integer | Yes |
| age_days | integer | Yes |
| tags | array | No |

---

## BacklogListResponse

| Field | Type | Required |
|-------|------|----------|
| result | array | Yes |
| has_more | boolean | No |
| num_pages |  | No |
| total |  | No |

---

## BacklogRow

| Field | Type | Required |
|-------|------|----------|
| suggestion | SuggestionResponse | Yes |
| gallery | BacklogGallery | Yes |

---

## BlacklistListResponse

| Field | Type | Required |
|-------|------|----------|
| tags | array | Yes |
| count | integer | Yes |

---

## BlacklistResponse

| Field | Type | Required |
|-------|------|----------|
| success | boolean | Yes |
| count | integer | Yes |

---

## BlacklistUpdateRequest

| Field | Type | Required |
|-------|------|----------|
| added | array | No |
| removed | array | No |

---

## BlacklistedTagResponse

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| type | string | Yes |
| name | string | Yes |
| slug | string | Yes |
| count | integer | Yes |

---

## Body_confirm_password_reset_api_v2_auth_reset_confirm_post

| Field | Type | Required |
|-------|------|----------|
| token | string | Yes |
| password | string | Yes |
| pow_challenge | string | Yes |
| pow_nonce | string | Yes |
| captcha_response | string | Yes |

---

## Body_create_api_key_api_v2_user_keys_post

| Field | Type | Required |
|-------|------|----------|
| name | string | Yes |
| purpose | string | No |
| pow_challenge | string | Yes |
| pow_nonce | string | Yes |
| captcha_response | string | Yes |

---

## Body_create_comment_api_v2_galleries__gallery_id__comments_post

| Field | Type | Required |
|-------|------|----------|
| body | string | Yes |
| captcha_response |  | No |
| pow_challenge | string | Yes |
| pow_nonce | string | Yes |

---

## Body_create_suggestion_api_v2_galleries__gallery_id__suggestions_post

| Field | Type | Required |
|-------|------|----------|
| tag_id | integer | Yes |
| action | string | No |
| captcha_response |  | No |
| pow_challenge | string | Yes |
| pow_nonce | string | Yes |

---

## Body_create_taxonomy_comment_api_v2_taxonomy__suggestion_id__comments_post

| Field | Type | Required |
|-------|------|----------|
| body | string | Yes |
| captcha_response |  | No |
| pow_challenge | string | Yes |
| pow_nonce | string | Yes |

---

## Body_create_taxonomy_suggestion_api_v2_taxonomy_post

| Field | Type | Required |
|-------|------|----------|
| action | string | Yes |
| target_tag_id |  | No |
| merge_into_tag_id |  | No |
| new_name |  | No |
| new_type |  | No |
| new_description |  | No |
| proposer_note |  | No |
| captcha_response |  | No |
| pow_challenge | string | Yes |
| pow_nonce | string | Yes |

---

## Body_edit_taxonomy_suggestion_api_v2_taxonomy__suggestion_id__patch

| Field | Type | Required |
|-------|------|----------|
| action | string | Yes |
| target_tag_id |  | No |
| merge_into_tag_id |  | No |
| new_name |  | No |
| new_type |  | No |
| new_description |  | No |
| proposer_note |  | No |
| summary |  | No |

---

## Body_login_api_v2_auth_login_post

| Field | Type | Required |
|-------|------|----------|
| username | string | Yes |
| password | string | Yes |
| pow_challenge | string | Yes |
| pow_nonce | string | Yes |
| captcha_response | string | Yes |

---

## Body_logout_api_v2_auth_logout_post

| Field | Type | Required |
|-------|------|----------|
| refresh_token | string | Yes |

---

## Body_refresh_api_v2_auth_refresh_post

| Field | Type | Required |
|-------|------|----------|
| refresh_token | string | Yes |

---

## Body_register_api_v2_auth_register_post

| Field | Type | Required |
|-------|------|----------|
| username | string | Yes |
| email | string | Yes |
| password | string | Yes |
| pow_challenge | string | Yes |
| pow_nonce | string | Yes |
| captcha_response | string | Yes |

---

## Body_request_password_reset_api_v2_auth_reset_post

| Field | Type | Required |
|-------|------|----------|
| username_or_email | string | Yes |
| pow_challenge | string | Yes |
| pow_nonce | string | Yes |
| captcha_response | string | Yes |

---

## Body_update_spam_config_api_v2_moderation_spam_config__name__put

| Field | Type | Required |
|-------|------|----------|
| items | array | Yes |

---

## Body_upload_avatar_api_v2_user_avatar_post

| Field | Type | Required |
|-------|------|----------|
| avatar | string | Yes |

---

## Body_vote_on_suggestion_api_v2_galleries__gallery_id__suggestions__suggestion_id__vote_post

| Field | Type | Required |
|-------|------|----------|
| vote | integer | Yes |
| pow_challenge | string | Yes |
| pow_nonce | string | Yes |

---

## Body_vote_on_taxonomy_suggestion_api_v2_taxonomy__suggestion_id__vote_post

| Field | Type | Required |
|-------|------|----------|
| vote | integer | Yes |
| pow_challenge | string | Yes |
| pow_nonce | string | Yes |

---

## CaptchaErrorResponse

| Field | Type | Required |
|-------|------|----------|
| error | string | Yes |
| captcha_required | boolean | No |
| captcha_public_key | string | Yes |

---

## CaptchaInfoResponse

| Field | Type | Required |
|-------|------|----------|
| provider | string | Yes |
| site_key | string | Yes |

---

## CdnConfigResponse

| Field | Type | Required |
|-------|------|----------|
| image_servers | array | Yes |
| thumb_servers | array | Yes |

---

## CommentResponse

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| gallery_id | integer | Yes |
| poster | UserPublic | Yes |
| post_date | integer | Yes |
| body | string | Yes |

---

## ConfigResponse

| Field | Type | Required |
|-------|------|----------|
| image_servers | array | Yes |
| thumb_servers | array | Yes |
| announcement |  | No |

---

## CoverInfo

| Field | Type | Required |
|-------|------|----------|
| path | string | Yes |
| width | integer | Yes |
| height | integer | Yes |

---

## CreateTagRequest

| Field | Type | Required |
|-------|------|----------|
| type | string | Yes |
| name | string | Yes |

---

## CreatedTag

| Field | Type | Required |
|-------|------|----------|
| type | string | Yes |
| name | string | Yes |

---

## CreatedTagResponse

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| type | string | Yes |
| name | string | Yes |
| slug | string | Yes |
| url | string | Yes |

---

## CreativeSlot

| Field | Type | Required |
|-------|------|----------|
| type | string | No |
| name | string | Yes |
| params | object | No |

---

## DeleteProfileRequest

| Field | Type | Required |
|-------|------|----------|
| password | string | Yes |
| confirmation | string | Yes |

---

## DeleteProfileResponse

| Field | Type | Required |
|-------|------|----------|
| success | boolean | Yes |
| message | string | Yes |

---

## DownloadResponse

| Field | Type | Required |
|-------|------|----------|
| url | string | Yes |
| expires_at | integer | Yes |

---

## EditListResponse

| Field | Type | Required |
|-------|------|----------|
| edits | array | Yes |
| count | integer | Yes |

---

## EditResponse

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| user_id |  | Yes |
| user_username |  | Yes |
| gallery_id | integer | Yes |
| gallery_title |  | Yes |
| date | integer | Yes |
| accepted |  | Yes |
| added_tags | array | Yes |
| removed_tags | array | Yes |
| created_tags | array | Yes |
| upvotes | integer | No |
| downvotes | integer | No |
| user_vote |  | No |

---

## EditTagInfo

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| type | string | Yes |
| name | string | Yes |
| slug | string | Yes |
| count | integer | Yes |
| action | string | Yes |

---

## ErrorResponse

| Field | Type | Required |
|-------|------|----------|
| error | string | Yes |

---

## FavoriteResponse

| Field | Type | Required |
|-------|------|----------|
| favorited | boolean | Yes |
| num_favorites |  | No |

---

## FlagCommentRequest

| Field | Type | Required |
|-------|------|----------|
| reason | string | Yes |

---

## GalleryDetailResponse

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| media_id | string | Yes |
| title | GalleryTitle | Yes |
| cover | CoverInfo | Yes |
| thumbnail | CoverInfo | Yes |
| scanlator | string | No |
| upload_date | integer | Yes |
| tags | array | Yes |
| num_pages | integer | Yes |
| num_favorites | integer | Yes |
| pages | array | No |
| comments |  | No |
| comment_count |  | No |
| related |  | No |
| is_favorited |  | No |
| suggestions |  | No |

---

## GalleryLinkPreview

| Field | Type | Required |
|-------|------|----------|
| start | integer | Yes |
| end | integer | Yes |
| matched | string | Yes |
| kind | string | No |
| gallery | GalleryListItem | Yes |

---

## GalleryListItem

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| media_id | string | Yes |
| english_title | string | Yes |
| japanese_title |  | No |
| thumbnail | string | Yes |
| thumbnail_width | integer | Yes |
| thumbnail_height | integer | Yes |
| num_pages | integer | No |
| num_favorites | integer | No |
| tag_ids | array | No |
| blacklisted | boolean | No |

---

## GallerySuggestionsBundle

| Field | Type | Required |
|-------|------|----------|
| trending | array | Yes |
| active | array | Yes |
| mine | array | No |
| counts | SuggestionTierCounts | Yes |

---

## GalleryTitle

| Field | Type | Required |
|-------|------|----------|
| english | string | Yes |
| japanese |  | No |
| pretty | string | Yes |

---

## HTTPValidationError

| Field | Type | Required |
|-------|------|----------|
| detail | array | No |

---

## HiddenGalleryResponse

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| hidden | boolean | Yes |

---

## HtmlSlot

| Field | Type | Required |
|-------|------|----------|
| type | string | No |
| html | string | Yes |

---

## ModerationApiKeyItem

| Field | Type | Required |
|-------|------|----------|
| id | string | Yes |
| key_prefix | string | Yes |
| name |  | Yes |
| purpose |  | Yes |
| scopes |  | Yes |
| created_at | string | Yes |
| last_used_at |  | Yes |
| user_id | integer | Yes |
| username | string | Yes |
| user_slug | string | Yes |

---

## ModerationApiKeysListResponse

| Field | Type | Required |
|-------|------|----------|
| keys | array | Yes |
| total | integer | Yes |
| page | integer | Yes |
| per_page | integer | Yes |
| num_pages | integer | Yes |

---

## ModerationCommentResponse

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| gallery_id | integer | Yes |
| gallery_title |  | Yes |
| poster_id | integer | Yes |
| poster_username | string | Yes |
| poster_slug | string | Yes |
| poster_avatar | string | Yes |
| poster_is_shadowbanned | boolean | Yes |
| body | string | Yes |
| post_date | integer | Yes |
| is_hidden | boolean | Yes |

---

## ModerationCommentsListResponse

| Field | Type | Required |
|-------|------|----------|
| comments | array | Yes |
| total | integer | Yes |
| page | integer | Yes |
| per_page | integer | Yes |
| num_pages | integer | Yes |

---

## ModerationFlagItem

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| user_id | integer | Yes |
| comment_id | integer | Yes |
| reason |  | Yes |
| date | integer | Yes |
| poster_id | integer | Yes |
| poster_username | string | Yes |
| poster_slug | string | Yes |
| poster_avatar | string | Yes |
| poster_is_shadowbanned | boolean | Yes |
| reporter_username | string | Yes |
| reporter_slug | string | Yes |
| reporter_avatar | string | Yes |
| comment_body | string | Yes |
| gallery_id | integer | Yes |
| gallery_title |  | Yes |

---

## ModerationFlagsListResponse

| Field | Type | Required |
|-------|------|----------|
| flags | array | Yes |
| total | integer | Yes |
| page | integer | Yes |
| per_page | integer | Yes |
| num_pages | integer | Yes |

---

## ModerationGalleryInfo

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| hidden | boolean | Yes |

---

## ModerationUserInfo

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| is_shadowbanned | boolean | Yes |
| email |  | No |

---

## NewTagIndexEntry

| Field | Type | Required |
|-------|------|----------|
| tag | TagResponse | Yes |
| created_at | integer | Yes |
| pending_gts_count | integer | Yes |

---

## NewTagIndexResponse

| Field | Type | Required |
|-------|------|----------|
| result | array | Yes |

---

## PageInfo

| Field | Type | Required |
|-------|------|----------|
| number | integer | Yes |
| path | string | Yes |
| width | integer | Yes |
| height | integer | Yes |
| thumbnail | string | Yes |
| thumbnail_width | integer | Yes |
| thumbnail_height | integer | Yes |

---

## PaginatedResponse_CommentResponse_

| Field | Type | Required |
|-------|------|----------|
| result | array | Yes |
| num_pages | integer | Yes |
| per_page | integer | No |
| total |  | No |

---

## PaginatedResponse_GalleryListItem_

| Field | Type | Required |
|-------|------|----------|
| result | array | Yes |
| num_pages | integer | Yes |
| per_page | integer | No |
| total |  | No |

---

## PoWChallengeResponse

| Field | Type | Required |
|-------|------|----------|
| challenge | string | Yes |
| difficulty | integer | Yes |

---

## PopunderInventoryResponse

| Field | Type | Required |
|-------|------|----------|
| name |  | No |
| delta |  | No |

---

## RecentComment

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| gallery_id | integer | Yes |
| body | string | Yes |
| post_date | integer | Yes |
| gallery_title | string | Yes |

---

## RecentFavorite

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| media_id | string | Yes |
| thumbnail | string | Yes |
| thumbnail_width | integer | Yes |
| thumbnail_height | integer | Yes |
| english_title | string | Yes |
| japanese_title |  | No |
| num_pages | integer | No |
| tag_ids | array | No |

---

## RecordPopunderRequest

| Field | Type | Required |
|-------|------|----------|
| name | string | Yes |
| type | string | No |
| record | boolean | No |

---

## RecordPopunderResponse

| Field | Type | Required |
|-------|------|----------|
| success | boolean | No |

---

## RefreshResponse

| Field | Type | Required |
|-------|------|----------|
| access_token | string | Yes |
| refresh_token | string | Yes |
| user | UserInfo | Yes |

---

## RelatedGalleriesResponse

| Field | Type | Required |
|-------|------|----------|
| result | array | Yes |

---

## ResolveSuggestionRequest

| Field | Type | Required |
|-------|------|----------|
| note |  | No |

---

## ResolveTaxonomySuggestionRequest

| Field | Type | Required |
|-------|------|----------|
| note |  | No |
| name_override |  | No |
| description_override |  | No |

---

## ReviewFlagRequest

| Field | Type | Required |
|-------|------|----------|
| action | string | Yes |

---

## ReviewFlagResponse

| Field | Type | Required |
|-------|------|----------|
| success | boolean | Yes |
| is_user_shadowbanned | boolean | No |

---

## SessionListItem

| Field | Type | Required |
|-------|------|----------|
| id | string | Yes |
| created_at | integer | Yes |
| expires_at | integer | Yes |
| ip_address |  | No |
| user_agent |  | No |
| current | boolean | No |

---

## ShadowbanResponse

| Field | Type | Required |
|-------|------|----------|
| shadowbanned | boolean | Yes |

---

## SubmitEditRequest

| Field | Type | Required |
|-------|------|----------|
| created_tags | array | No |
| added_tags | array | No |
| removed_tags | array | No |

---

## SubmitEditResponse

| Field | Type | Required |
|-------|------|----------|
| success | boolean | Yes |
| edit_id | integer | Yes |
| auto_applied | boolean | Yes |

---

## SuccessResponse

| Field | Type | Required |
|-------|------|----------|
| success | boolean | No |
| message |  | No |

---

## SuggestionListResponse

| Field | Type | Required |
|-------|------|----------|
| result | array | Yes |
| has_more |  | No |
| num_pages |  | No |
| total |  | No |

---

## SuggestionProposer

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| username | string | Yes |
| slug |  | No |
| avatar_url |  | No |

---

## SuggestionResponse

| Field | Type | Required |
|-------|------|----------|
| id | string | Yes |
| gallery_id | integer | Yes |
| tag | SuggestionTag | Yes |
| action | string | Yes |
| status | string | Yes |
| score |  | No |
| voter_count | integer | Yes |
| proposer | SuggestionProposer | Yes |
| created_at | string | Yes |
| resolved_at |  | No |
| resolver |  | No |
| resolution_note |  | No |
| reverted_at |  | No |
| reverter |  | No |
| my_vote |  | No |
| tier |  | No |

---

## SuggestionTag

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| type | string | Yes |
| name | string | Yes |
| slug | string | Yes |
| url | string | Yes |
| description |  | No |

---

## SuggestionTierCounts

| Field | Type | Required |
|-------|------|----------|
| trending | integer | No |
| active | integer | No |
| declined | integer | No |
| hidden | integer | No |

---

## TagPaginatedResponse

| Field | Type | Required |
|-------|------|----------|
| result | array | Yes |
| num_pages | integer | Yes |
| per_page | integer | No |
| total |  | No |
| alphabet |  | No |

---

## TagResponse

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| type | string | Yes |
| name | string | Yes |
| slug | string | Yes |
| url | string | Yes |
| count | integer | Yes |
| description |  | No |
| is_community |  | No |
| pending_describe_id |  | No |

---

## TaxonomyCommentAuthor

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| username | string | Yes |
| slug | string | Yes |
| avatar_url |  | No |
| is_staff | boolean | No |
| is_superuser | boolean | No |

---

## TaxonomyCommentListResponse

| Field | Type | Required |
|-------|------|----------|
| result | array | Yes |
| has_more |  | No |
| num_pages |  | No |
| total |  | No |

---

## TaxonomyCommentResponse

| Field | Type | Required |
|-------|------|----------|
| id | string | Yes |
| body | string | Yes |
| author | TaxonomyCommentAuthor | Yes |
| created_at | string | Yes |
| can_delete | boolean | No |
| link_previews | array | No |

---

## TaxonomyLinkPreview

| Field | Type | Required |
|-------|------|----------|
| start | integer | Yes |
| end | integer | Yes |
| matched | string | Yes |
| kind | string | No |
| suggestion | TaxonomySuggestionResponse | Yes |

---

## TaxonomySuggestionEditChange

| Field | Type | Required |
|-------|------|----------|
| field | string | Yes |
| old_value |  | No |
| new_value |  | No |

---

## TaxonomySuggestionEditEntry

| Field | Type | Required |
|-------|------|----------|
| id | string | Yes |
| created_at | string | Yes |
| summary |  | No |
| changes | array | Yes |
| editor |  | No |

---

## TaxonomySuggestionEditListResponse

| Field | Type | Required |
|-------|------|----------|
| result | array | Yes |

---

## TaxonomySuggestionListResponse

| Field | Type | Required |
|-------|------|----------|
| result | array | Yes |
| has_more |  | No |
| num_pages |  | No |
| total |  | No |

---

## TaxonomySuggestionProposer

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| username | string | Yes |
| slug |  | No |
| avatar_url |  | No |

---

## TaxonomySuggestionResolver

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| username | string | Yes |
| slug |  | No |
| avatar_url |  | No |

---

## TaxonomySuggestionResponse

| Field | Type | Required |
|-------|------|----------|
| id | string | Yes |
| action | string | Yes |
| status | string | Yes |
| score | integer | Yes |
| voter_count | integer | Yes |
| proposer | TaxonomySuggestionProposer | Yes |
| proposer_note |  | No |
| created_at | string | Yes |
| edited_at |  | No |
| resolved_at |  | No |
| resolution_note |  | No |
| resolver |  | No |
| target_tag |  | No |
| merge_into_tag |  | No |
| new_name |  | No |
| new_type |  | No |
| new_description |  | No |
| accepted_type |  | No |
| accepted_name |  | No |
| accepted_description |  | No |
| resolved_tag |  | No |
| my_vote |  | No |
| tier |  | No |
| tier_page |  | No |
| comment_count | integer | No |
| recent_comments | array | No |

---

## TaxonomySuggestionStats

| Field | Type | Required |
|-------|------|----------|
| pending | integer | Yes |
| accepted_total | integer | Yes |
| rejected_total | integer | Yes |
| accepted_30d | integer | Yes |
| accepted_7d | integer | Yes |
| created_30d | integer | Yes |
| renamed_30d | integer | Yes |
| merged_30d | integer | Yes |
| described_30d | integer | Yes |
| trending_count | integer | No |
| active_count | integer | No |
| declined_count | integer | No |
| recent_accepted | array | Yes |

---

## TaxonomySuggestionTag

| Field | Type | Required |
|-------|------|----------|
| id |  | No |
| type | string | Yes |
| name | string | Yes |
| slug | string | Yes |
| url |  | No |
| count |  | No |
| description |  | No |

---

## TokenResponse

| Field | Type | Required |
|-------|------|----------|
| access_token | string | Yes |
| refresh_token | string | Yes |
| user | UserInfo | Yes |

---

## UpdateProfileRequest

| Field | Type | Required |
|-------|------|----------|
| username |  | No |
| email |  | No |
| about |  | No |
| favorite_tags |  | No |
| theme |  | No |
| current_password |  | No |
| new_password |  | No |
| default_avatar |  | No |

---

## UpdateProfileResponse

| Field | Type | Required |
|-------|------|----------|
| success | boolean | Yes |
| username | string | Yes |
| email |  | No |
| avatar_url | string | Yes |
| about | string | No |
| favorite_tags | string | No |
| theme | string | No |

---

## UserInfo

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| username | string | Yes |
| slug | string | Yes |
| avatar_url | string | Yes |
| theme | string | No |
| is_staff | boolean | No |
| is_superuser | boolean | No |

---

## UserMeResponse

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| username | string | Yes |
| slug | string | Yes |
| avatar_url | string | Yes |
| theme | string | No |
| is_staff | boolean | No |
| is_superuser | boolean | No |
| about | string | No |
| favorite_tags | string | No |
| email |  | No |

---

## UserProfileResponse

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| username | string | Yes |
| slug | string | Yes |
| avatar_url | string | Yes |
| is_superuser | boolean | No |
| is_staff | boolean | No |
| date_joined | integer | Yes |
| about | string | No |
| favorite_tags | string | No |
| recent_favorites | array | Yes |
| recent_comments | array | Yes |

---

## UserPublic

| Field | Type | Required |
|-------|------|----------|
| id | integer | Yes |
| username | string | Yes |
| slug | string | Yes |
| avatar_url | string | Yes |
| is_superuser | boolean | No |
| is_staff | boolean | No |

---

## ValidationError

| Field | Type | Required |
|-------|------|----------|
| loc | array | Yes |
| msg | string | Yes |
| type | string | Yes |
| input |  | No |
| ctx | object | No |

---

## VoteRequest

| Field | Type | Required |
|-------|------|----------|
| accept | boolean | Yes |

---

## VoteResponse

| Field | Type | Required |
|-------|------|----------|
| success | boolean | Yes |
| upvotes | integer | Yes |
| downvotes | integer | Yes |

---

## ZonesResponse

| Field | Type | Required |
|-------|------|----------|
| zones | object | Yes |

---
