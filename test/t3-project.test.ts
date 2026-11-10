import { describe, expect, test } from "bun:test";

import { findProject } from "../src/t3-project";

const projects = [
    { id: "21536618-243b-4995-94e3-cea17dfc0790", title: "medical-gmktek" },
    { id: "9770c6c8-21f2-472e-9d9a-cc153a6d7740", title: "No project" },
];

describe("findProject", () => {
    test("finds a project by id", () => {
        expect(findProject(projects, "21536618-243b-4995-94e3-cea17dfc0790")).toBe(
            "21536618-243b-4995-94e3-cea17dfc0790",
        );
    });

    test("finds a project by its title, ignoring case and surrounding spaces", () => {
        expect(findProject(projects, " Medical-GMKTEK ")).toBe("21536618-243b-4995-94e3-cea17dfc0790");
    });

    test("explains which projects exist when none matches", () => {
        expect(() => findProject(projects, "medical")).toThrow(
            'T3 project "medical" not found. Set T3_PROJECT_ID to one of: medical-gmktek (21536618-243b-4995-94e3-cea17dfc0790), No project (9770c6c8-21f2-472e-9d9a-cc153a6d7740)',
        );
    });
});
