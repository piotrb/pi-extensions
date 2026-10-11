let's create a few tests for the tool policy package

First of all we should examine all the tests already existing to understand how similar things are being tested.

The goal would be to make this behavior testable, but also to use 100% of the actual business logic code in the test so we're testing the real deal.

This may require some refactors to create the right testable units.

Test class 1:

the goal would be to match specific bash commands, and see what the effective metadata ends up being ..

eg:

Allow tool call: bash?
bash_cmd: "rm -rf /home/piotr/Work/pi-extensions/.eslintcache"
Mode: edit · Tags: execution

Rules that fired:
tag:execution = ask [applied]
default:<default> = ask [shadowed]

Inputs:
the rules, this should allow injection of all the rules ..

1. the merged "global" rules, like tagging rules
2. current mode
3. the resolved/merged/inherited single final mode specific rules to test against
4. a tool call input (whatever the pi data shape is for the tool call info)

Output:
the inputs that to into the user ask above, so list or rules, their decision/state .. list of tags .. decision

Test Class 2:

testing the whole composition of the rules ..
Inputs:

1. toggle for enable stock rules (default true)
2. pass in the configs individually from each level

Output:
the combined properly merged config

Test Class 3:

resolving the current mode's effective config

Inputs:

1. toggle for enable stock rules (default true)
2. the current mode
3. pass in the final resolved rules for the current mode

Output:
the resolved/merged/inherited config for the current mode

---

for the decide abstraction tests ..

I'd like to plan for the shape of the test side of this.

I want to make it easy to throw cases at this, this is one of the most clear surfaces for how the user sees this work and integrates a lot of the inner workings.

So we should have easy/simple helpers for prepating the inputs here, and perhaps easier ways of asserting things if needed.

specific case I want to cover (this seems broken when I have this interaction as a user of the extension, so this may also have to include figuring out what's wrong and fixing it).

I'm concerned that too much YOLO decisions have lead up to this breaking, so I'd like more active user interaction for this part. You are to investigate after creating the test and seeing it fail, then present your findings along with recommendation and wait for the user to confirm the direction.

Allow tool call: bash?
bash_cmd: "rm -rf /home/piotr/Work/pi-extensions/.eslintcache"

with a tagging rules:

taggingRules: [
{
tool: "bash",
fields: { command: ["wc *", "ls", "ls *"] },
action: { type: "addTags", tags: ["readonly"] },
},
{
tool: "bash",
fields: { command: ["mkdir *", "rmdir *", "rm *"] },
action: { type: "addTags", tags: ["mutating"] },
},
],

Should have that match and add the mutating tag ..

Also interestingly .. another simple case:

Allow tool call: bash?
bash_cmd: "ls packages/pi-tool-policy/src/lib/tagging-rules.test.ts"
Mode: edit · Tags: execution, readonly

This did seem to match the readonly tagging rule ..

BUT .. because tag rule for execution requires ask .. it still asked ..
so maybe we need to add a new tag rule action "removeTags" so execution could be optionally stripped in rules if needed ..

---

in default mode, when write request comes in .. (or a mutating tag) or whatever ..
one of the options on the menu should be to switch mode to edit mode

---
