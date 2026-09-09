export type DefaultErrorMap = Record<string, string | Record<string, string>>;

const defaultErrors: DefaultErrorMap = {
  required: "The :attribute field is required.",
  present: "The :attribute field must be present.",
  filled: "The :attribute field must have a value.",
  string: "The :attribute field must be a string.",
  numeric: "The :attribute field must be a number.",
  integer: "The :attribute field must be an integer.",
  boolean: "The :attribute field must be true or false.",
  array: "The :attribute field must be an array.",
  file: "The :attribute field must be a file.",
  image: "The :attribute field must be an image.",
  object: "The :attribute field must be an object.",
  email: "The :attribute field must be a valid email address.",
  uuid: "The :attribute field must be a valid UUID.",
  ulid: "The :attribute field must be a valid ULID.",
  url: "The :attribute field must be a valid URL.",
  regex: "The :attribute field format is invalid.",
  alpha: "The :attribute field must only contain letters.",
  alpha_num: "The :attribute field must only contain letters and numbers.",
  alpha_dash: "The :attribute field must only contain letters, numbers, dashes, and underscores.",
  digits: "The :attribute field must be :digits digits.",
  digits_between: "The :attribute field must be between :min and :max digits.",
  json: "The :attribute field must be a valid JSON string.",
  ip: "The :attribute field must be a valid IP address.",
  ipv4: "The :attribute field must be a valid IPv4 address.",
  ipv6: "The :attribute field must be a valid IPv6 address.",
  timezone: "The :attribute field must be a valid timezone.",
  date: "The :attribute field must be a valid date.",
  date_format: "The :attribute field must match the format :format.",
  after: "The :attribute field must be a date after :date.",
  after_or_equal: "The :attribute field must be a date after or equal to :date.",
  before: "The :attribute field must be a date before :date.",
  before_or_equal: "The :attribute field must be a date before or equal to :date.",
  accepted: "The :attribute field must be accepted.",
  declined: "The :attribute field must be declined.",
  prohibited: "The :attribute field is prohibited.",
  distinct: "The :attribute field has a duplicate value.",
  required_array_keys: "The :attribute field must contain entries for: :values.",
  starts_with: "The :attribute field must start with :values.",
  ends_with: "The :attribute field must end with :values.",
  lowercase: "The :attribute field must be lowercase.",
  uppercase: "The :attribute field must be uppercase.",
  confirmed: "The :attribute field confirmation does not match.",
  in: "The selected :attribute is invalid.",
  not_in: "The selected :attribute is invalid.",
  same: "The :attribute field must match :other.",
  different: "The :attribute field and :other must be different.",
  enum: "The selected :attribute is invalid.",
  mimes: "The :attribute field must be a file of type: :values.",
  extensions: "The :attribute field must have one of the following extensions: :values.",
  exists: "The selected :attribute is invalid.",
  unique: "The :attribute has already been taken.",
  multiple_of: "The :attribute field must be a multiple of :value.",
  size: {
    string: "The :attribute field must be :size characters.",
    numeric: "The :attribute field must be :size.",
    file: "The :attribute field must be :size kilobytes.",
    array: "The :attribute field must contain :size items.",
  },
  gt: {
    string: "The :attribute field must be greater than :value characters.",
    numeric: "The :attribute field must be greater than :value.",
    file: "The :attribute field must be greater than :value kilobytes.",
    array: "The :attribute field must have more than :value items.",
  },
  gte: {
    string: "The :attribute field must be greater than or equal to :value characters.",
    numeric: "The :attribute field must be greater than or equal to :value.",
    file: "The :attribute field must be greater than or equal to :value kilobytes.",
    array: "The :attribute field must have :value items or more.",
  },
  lt: {
    string: "The :attribute field must be less than :value characters.",
    numeric: "The :attribute field must be less than :value.",
    file: "The :attribute field must be less than :value kilobytes.",
    array: "The :attribute field must have less than :value items.",
  },
  lte: {
    string: "The :attribute field must be less than or equal to :value characters.",
    numeric: "The :attribute field must be less than or equal to :value.",
    file: "The :attribute field must be less than or equal to :value kilobytes.",
    array: "The :attribute field must not have more than :value items.",
  },
  min: {
    string: "The :attribute field must be at least :min characters.",
    numeric: "The :attribute field must be at least :min.",
    file: "The :attribute field must be at least :min kilobytes.",
    array: "The :attribute field must have at least :min items.",
  },
  max: {
    string: "The :attribute field must not be greater than :max characters.",
    numeric: "The :attribute field must not be greater than :max.",
    file: "The :attribute field must not be greater than :max kilobytes.",
    array: "The :attribute field must not have more than :max items.",
  },
  between: {
    string: "The :attribute field must be between :min and :max characters.",
    numeric: "The :attribute field must be between :min and :max.",
    file: "The :attribute field must be between :min and :max kilobytes.",
    array: "The :attribute field must have between :min and :max items.",
  },
};

let errors: DefaultErrorMap = { ...defaultErrors };
let attributes: Record<string, string> = {};

export function getDefaultErrors(): DefaultErrorMap {
  return errors;
}

export function getDefaultAttributes(): Record<string, string> {
  return attributes;
}

export function setDefaultErrors(map: DefaultErrorMap): void {
  errors = { ...defaultErrors, ...map };
}

export function setDefaultAttributes(map: Record<string, string>): void {
  attributes = { ...map };
}

export function resetDefaults(): void {
  errors = { ...defaultErrors };
  attributes = {};
}

export function humanize(key: string): string {
  return key.replace(/_/g, " ").replace(/\./g, " ");
}

export function attributeName(field: string, override?: string): string {
  if (override) {
    return override;
  }

  return attributes[field] ?? humanize(field);
}

export function interpolate(
  template: string,
  replacements: Record<string, string | number | undefined>,
): string {
  // Single pass over `:name` tokens so a shorter key (`:value`) can't
  // clobber a longer one (`:values`). Longest-match is guaranteed because
  // `\w+` is greedy: `:values` is consumed whole before `:value` is tried.
  return template.replace(/:(\w+)/g, (match, key: string) => {
    const value = replacements[key];

    return value === undefined ? match : String(value);
  });
}

export function defaultMessage(rule: string, valueType?: string): string {
  const entry = errors[rule];

  if (typeof entry === "string") {
    return entry;
  }

  if (entry && valueType && typeof entry[valueType] === "string") {
    return entry[valueType];
  }

  if (entry && typeof entry.string === "string") {
    return entry.string;
  }

  return `The :attribute field is invalid.`;
}
