---
name: hackery-update-skill
description: update one of the skills
---

This skill manages skills inside the pi-hackery package in packages/pi-hackery

Given the named skill requested (abort if one was not specified).
Look for the corresponding "base" file "base/skills/{name}.md" and read that.

Then, check if the destination skill already exists. "skills/{name}/SKILL.md". (this is a skills folder off the root of this project, not in .agents/skills)

If it does not, plan to create the skill based on the base. Make sure to plan to add the right frontmatter to the top of it. Specifically name and description. Name must match the file path.

It it does, you are to analyze if the skill covers the base.
If there is any potential changes to be made, this can be both extreneous things not covered by the base, incorrect things no longer aligning with the base or missing details which the base is asking for; plan the corresponding edits.

In either case, guidelines to keep in mind:

- keep an imperative tone
- when making edits, try to make the most minimal change to accomplish the job to avoid large re-writes of little value
- you may not use the colon character in the description frontmatter since that will generate invalid yaml

Do not make the edits yet, compose a list of these changes for the user's final approval.

Do not accept implied approval, only accept explicit approval.

Once the user approves, make the edits.
