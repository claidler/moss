const test = require("node:test");
const assert = require("node:assert/strict");
const { projectSkills, matchSkills } = require("./commands");

test("projectSkills keeps slash-invocable skills only", () => {
  const { skills } = projectSkills({
    commands: [
      { name: "help", source: "native", description: "Show help" },
      { name: "/weather", source: "skill", skillDisplayName: "Weather", description: "Look up the forecast" },
      { name: "weather", source: "skill", description: "duplicate" },
      { name: "", source: "skill" },
      null,
      { name: "maps", source: "skill", description: "Find a place" },
    ],
  });
  assert.deepEqual(skills.map((s) => s.name), ["maps", "weather"]);
  assert.equal(skills[1].title, "Weather");
  assert.equal(skills[1].description, "Look up the forecast");
});

test("projectSkills treats missing commands as empty", () => {
  assert.deepEqual(projectSkills(null), { skills: [] });
  assert.deepEqual(projectSkills({}), { skills: [] });
});

test("matchSkills ranks prefix hits first", () => {
  const skills = [
    { name: "web-research", title: "Web research", description: "Search the web" },
    { name: "weather", title: "Weather", description: "Look up the forecast" },
    { name: "maps", title: "Maps", description: "Find a place" },
  ];
  assert.deepEqual(matchSkills(skills, "we").map((s) => s.name), ["weather", "web-research"]);
  assert.deepEqual(matchSkills(skills, "forecast").map((s) => s.name), ["weather"]);
  assert.equal(matchSkills(skills, "nope").length, 0);
  assert.equal(matchSkills(skills, "").length, 3);
});
