import { describe, it, expect } from "vitest";
import {
  extractControlsFromJsx,
  extractParamsFromPage,
} from "../controls-scanner.js";

describe("extractControlsFromJsx — control kinds", () => {
  it("captures TextInput as input with placeholder label", () => {
    const src = `<TextInput placeholder="Search any city" />`;
    const c = extractControlsFromJsx(src);
    expect(c).toEqual([{ kind: "input", label: "Search any city" }]);
  });

  it("captures multiline TextInput as textarea", () => {
    const src = `<TextInput multiline placeholder="Notes" />`;
    const c = extractControlsFromJsx(src);
    expect(c[0]).toMatchObject({ kind: "textarea", label: "Notes" });
  });

  it("captures Native <Picker> with finite domain (value-first)", () => {
    // B2 regression: must capture the VALUE, not the display label.
    const src = `
      <Picker accessibilityLabel="status">
        <Picker.Item label="Draft" value="draft" />
        <Picker.Item label="Published" value="published" />
        <Picker.Item label="Rejected" value="rejected" />
      </Picker>`;
    const c = extractControlsFromJsx(src);
    const sel = c.find(x => x.kind === "select");
    expect(sel?.domain).toEqual(["draft", "published", "rejected"]);
  });

  it("falls back to label= when no value= on Picker.Item", () => {
    const src = `
      <Picker>
        <Picker.Item label="One"/>
        <Picker.Item label="Two"/>
      </Picker>`;
    const sel = extractControlsFromJsx(src).find(x => x.kind === "select");
    expect(sel?.domain).toEqual(["One", "Two"]);
  });

  it("custom <FooPicker> registers as select with no domain", () => {
    const src = `<CityFnsServicePicker onSelect={x} />`;
    const c = extractControlsFromJsx(src);
    expect(c).toEqual([{ kind: "select", label: "CityFnsServicePicker" }]);
  });

  it("does NOT double-count <CustomPicker.Item> as a separate select (S1)", () => {
    const src = `<CustomPicker.Item label="x" value="y" />`;
    const c = extractControlsFromJsx(src);
    expect(c.filter(x => x.kind === "select")).toHaveLength(0);
  });

  it("captures Switch as toggle", () => {
    const src = `<Switch value={true} accessibilityLabel="Notifications" />`;
    const c = extractControlsFromJsx(src);
    expect(c[0]).toMatchObject({ kind: "toggle", label: "Notifications" });
  });

  it("captures Slider", () => {
    const src = `<Slider minimumValue={0} maximumValue={100} accessibilityLabel="Volume" />`;
    const c = extractControlsFromJsx(src);
    expect(c[0]).toMatchObject({ kind: "slider", label: "Volume" });
  });

  it("captures scroll containers", () => {
    const src = `<ScrollView/><FlatList data={[]}/>`;
    const c = extractControlsFromJsx(src);
    expect(c.map(x => x.kind).sort()).toEqual(["scroll", "scroll"]);
  });

  it("captures OTP by component-name pattern", () => {
    const src = `<OtpCodeInput onComplete={x} />`;
    const c = extractControlsFromJsx(src);
    expect(c[0]).toMatchObject({ kind: "otp" });
  });

  it("captures OTP by number-pad + maxLength=1 heuristic", () => {
    const src = `<TextInput keyboardType="number-pad" maxLength={1} />`;
    const c = extractControlsFromJsx(src);
    expect(c[0].kind).toBe("otp");
  });

  it("expo-document-picker — single file with accept type", () => {
    const src = `
      import {} from "expo-document-picker";
      DocumentPicker.getDocumentAsync({ type: "application/pdf" });`;
    const c = extractControlsFromJsx(src);
    const f = c.find(x => x.kind === "file");
    expect(f?.accept).toBe("application/pdf");
  });

  it("expo-document-picker — multi-file", () => {
    const src = `
      import {} from "expo-document-picker";
      DocumentPicker.getDocumentAsync({ multiple: true, type: "image/*" });`;
    const c = extractControlsFromJsx(src);
    expect(c.some(x => x.kind === "files" && x.multiple === true)).toBe(true);
  });

  it("expo-image-picker — single image", () => {
    const src = `
      import {} from "expo-image-picker";
      ImagePicker.launchImageLibraryAsync();`;
    const c = extractControlsFromJsx(src);
    expect(c.some(x => x.kind === "image")).toBe(true);
  });

  it("submit hint surfaces once per file", () => {
    const src = `function f(){ const onSubmit = (v) => {}; }`;
    const c = extractControlsFromJsx(src);
    expect(c.filter(x => x.kind === "submit")).toHaveLength(1);
  });
});

describe("comment + string-literal stripping (S5)", () => {
  it("does NOT count JSX inside a // line comment", () => {
    const src = `// const x = <TextInput placeholder="ghost" />`;
    const c = extractControlsFromJsx(src);
    expect(c).toEqual([]);
  });

  it("does NOT count JSX inside a block comment", () => {
    const src = `/* <TextInput placeholder="ghost" /> */`;
    const c = extractControlsFromJsx(src);
    expect(c).toEqual([]);
  });

  it("trailing comment doesn't shadow real JSX above", () => {
    const src = `<TextInput placeholder="real" />  // ghost`;
    const c = extractControlsFromJsx(src);
    expect(c).toEqual([{ kind: "input", label: "real" }]);
  });

  it("https:// URLs in strings survive stripping", () => {
    const src = `const url = "https://api.example.com/foo"; <TextInput placeholder="x" />`;
    const c = extractControlsFromJsx(src);
    expect(c[0].label).toBe("x");
  });
});

describe("B1 regression: repeated calls don't silently miss patterns", () => {
  // Old bug: DOC_PICKER_IMPORT_RE / IMG_PICKER_IMPORT_RE / FILE_SYSTEM_DL_RE /
  // SUBMIT_BTN_RE were declared /g and used with .test(), so lastIndex carried
  // over → second call against similar source returned false.
  it("DocumentPicker import detected on repeat calls", () => {
    const src = `import {} from "expo-document-picker"; DocumentPicker.getDocumentAsync({});`;
    for (let i = 0; i < 3; i++) {
      const c = extractControlsFromJsx(src);
      expect(c.some(x => x.kind === "file")).toBe(true);
    }
  });

  it("ImagePicker import detected on repeat calls", () => {
    const src = `import {} from "expo-image-picker"; ImagePicker.launchImageLibraryAsync({});`;
    for (let i = 0; i < 3; i++) {
      const c = extractControlsFromJsx(src);
      expect(c.some(x => x.kind === "image")).toBe(true);
    }
  });

  it("submit detection survives repeat calls", () => {
    const src = `const handleSubmit = () => {};`;
    for (let i = 0; i < 3; i++) {
      const c = extractControlsFromJsx(src);
      expect(c.some(x => x.kind === "submit")).toBe(true);
    }
  });
});

describe("extractParamsFromPage — useLocalSearchParams", () => {
  it("parses TS-type-literal with string union", () => {
    const src = `const p = useLocalSearchParams<{ id: string; status?: 'draft' | 'published' | 'rejected' }>()`;
    const p = extractParamsFromPage(src);
    const status = p.find(x => x.name === "status");
    expect(status?.values).toEqual(["draft", "published", "rejected"]);
    expect(status?.required).toBe(false);
    const id = p.find(x => x.name === "id");
    expect(id?.required).toBe(true);
    expect(id?.type).toBe("string");
  });

  it("parses useGlobalSearchParams too", () => {
    const src = `useGlobalSearchParams<{ tab: "info" | "history" }>()`;
    const p = extractParamsFromPage(src);
    expect(p[0].values).toEqual(["info", "history"]);
  });
});
