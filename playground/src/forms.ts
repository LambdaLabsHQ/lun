/**
 * Inputs for a value of a host type, generated from its `Field`: a text box,
 * a choice of constructor with its arguments, or a record's fields.
 */
import { example, type Field, type Input } from "./host.ts";
import { el } from "./panels.ts";

export interface FieldInput {
  element: HTMLElement;
  read(): Input;
}

let ids = 0;

/**
 * Inputs for a field. `label` names the value; `initial` fills a text input.
 * A compact field names itself inside its input, as the answer of a request
 * card does; a record of one field is then that field's input alone.
 */
export function fieldInput(field: Field, label: string, initial = "", compact = false): FieldInput {
  const id = `field-${++ids}`;
  const labelled = (control: HTMLElement, hint: string | null = null): HTMLElement => {
    if (compact) {
      control.setAttribute("aria-label", label);
      if (!control.hasAttribute("placeholder")) control.setAttribute("placeholder", label);
      return el("div", { class: "form-row" }, control);
    }
    return el("div", { class: "form-row" },
      el("label", { for: id }, label),
      control,
      ...(hint === null ? [] : [el("span", { class: "form-hint" }, hint)]));
  };
  switch (field.kind) {
    case "text":
    case "abstract": {
      const input = el("input", { id, type: "text", autocomplete: "off", spellcheck: "false", value: initial });
      return {
        element: labelled(input, field.kind === "abstract" ? `${field.type}, a value only the host makes` : null),
        read: () => input.value,
      };
    }
    case "number": {
      const input = el("input", { id, type: "text", inputmode: field.type === "int" ? "numeric" : "decimal", autocomplete: "off", value: initial });
      return { element: labelled(input, field.type), read: () => input.value };
    }
    case "literal": {
      const input = el("input", { id, type: "text", autocomplete: "off", spellcheck: "false", placeholder: example(field.type), value: initial, class: "mono" });
      return { element: labelled(input, field.type), read: () => input.value };
    }
    case "bool": {
      const select = el("select", { id }, el("option", { value: "true" }, "true"), el("option", { value: "false" }, "false"));
      return { element: labelled(select), read: () => select.value === "true" };
    }
    case "unit":
      return { element: el("div", { hidden: "" }), read: () => "" };
    case "variant": {
      const select = el("select", { id }, ...field.constructors.map((ctor) => el("option", { value: ctor.name }, ctor.name)));
      const args = el("div", { class: "form-nested" });
      let inputs: FieldInput[] = [];
      const choose = () => {
        const ctor = field.constructors.find((candidate) => candidate.name === select.value);
        inputs = (ctor?.args() ?? []).map((argument, index, all) => fieldInput(argument, all.length === 1 ? `${select.value}’s value` : `${select.value}, argument ${index + 1}`));
        args.replaceChildren(...inputs.map((input) => input.element));
        args.hidden = inputs.length === 0;
      };
      select.addEventListener("change", choose);
      choose();
      return {
        element: el("div", { class: "form-group" }, labelled(select, field.type), args),
        read: () => ({ choice: select.value, args: inputs.map((input) => input.read()) }),
      };
    }
    case "record": {
      if (compact && field.fields.length === 1) {
        const [{ name, field: inner }] = field.fields as [{ name: string; field: Field }];
        const input = fieldInput(inner, label, initial, true);
        return { element: input.element, read: () => ({ fields: { [name]: input.read() } }) };
      }
      const inputs = field.fields.map(({ name, field: inner }) => ({ name, input: fieldInput(inner, name, "", compact) }));
      return {
        element: el("fieldset", { class: "form-record" },
          el("legend", {}, label.toLowerCase() === field.type ? label : `${label}, a ${field.type}`),
          ...inputs.map(({ input }) => input.element)),
        read: () => ({ fields: Object.fromEntries(inputs.map(({ name, input }) => [name, input.read()])) }),
      };
    }
    case "unsupported":
      return { element: el("p", { class: "form-hint" }, `${label}: the playground has no form for ${field.type} yet.`), read: () => "" };
  }
}
