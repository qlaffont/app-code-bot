import { describe, expect, test } from "bun:test";

import { findProject } from "../src/t3-project";

const projects = [
    { id: "21536618-243b-4995-94e3-cea17dfc0790", title: "test" },
    { id: "9770c6c8-21f2-472e-9d9a-cc153a6d7740", title: "No project" },
];

describe("findProject", () => {
    test("finds a project by id", () => {
        expect(findProject(projects, "21536618-243b-4995-94e3-cea17dfc0790")).toBe(
            "21536618-243b-4995-94e3-cea17dfc0790",
        );
    });

    test("finds a project by its title, ignoring case and surrounding spaces", () => {
        expect(findProject(projects, " test ")).toBe("21536618-243b-4995-94e3-cea17dfc0790");
    });

    test("explains which projects exist when none matches", () => {
        expect(() => findProject(projects, "billing")).toThrow(
            'T3 project "billing" not found. Set T3_PROJECT_ID to one of: test (21536618-243b-4995-94e3-cea17dfc0790), No project (9770c6c8-21f2-472e-9d9a-cc153a6d7740)',
        );
    });
});
