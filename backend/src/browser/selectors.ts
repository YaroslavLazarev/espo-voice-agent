/**
 * All EspoCRM selectors in one place. Verified against https://demo.eu.espocrm.com/
 * (see specs/design.md §5). Prefer data-* attributes over classes.
 */
export const selectors = {
  login: {
    username: '#field-userName',
    password: '#field-password',
    submit: '#btn-login',
  },
  /** Present (but not "visible") once the app shell is rendered after login. */
  appShell: '#navbar',
  nav: {
    contacts: '#navbar a[href="#Contact"]',
  },
  list: {
    createButton: '#main .header-buttons a[data-name="create"][data-action="create"]',
    searchInput: '#main .search-container input[data-name="textFilter"]',
    searchButton: '#main .search-container button[data-action="search"]',
    row: '#main .list tbody tr.list-row[data-id]',
    rowName: 'td[data-name="name"]',
    rowAccount: 'td[data-name="account"]',
    rowEmail: 'td[data-name="emailAddress"] [data-email-address]',
    rowPhone: 'td[data-name="phoneNumber"] [data-phone-number]',
    /** `id` is validated as alphanumeric by the tool schema, so it is safe inside the selector. */
    rowLink: (id: string) => `#main .list tbody tr.list-row td[data-name="name"] a[data-id="${id}"]`,
    showMore: '#main [data-action="showMore"]',
  },
  form: {
    salutationSelect: 'select[data-name="salutationName"]',
    salutationWidget: '.field[data-name="name"] .selectize-input',
    salutationOption: (value: string) => `.field[data-name="name"] .selectize-dropdown .option[data-value="${value}"]`,
    firstName: 'input[data-name="firstName"]',
    lastName: 'input[data-name="lastName"]',
    emailAddress: '.field[data-name="emailAddress"] input.email-address',
    phoneNumber: '.field[data-name="phoneNumber"] input.phone-number',
    save: '#main button[data-action="save"]',
    cancel: '#main button[data-action="cancel"]',
    errorAlert: '.alert-danger',
    validationPopover: '.popover.in',
  },
  duplicateDialog: {
    root: '.modal.in:has(.list-container)',
    create: '.modal.in:has(.list-container) button[data-name="save"]',
    cancel: '.modal.in:has(.list-container) button[data-name="cancel"]',
  },
  recordView: {
    name: '#main .record .field[data-name="name"]',
    /** The create form lingers briefly after the hash changes; the detail view has no inputs in the name field. */
    nameRendered: '#main .record .field[data-name="name"]:not(:has(input, select))',
    emailAddress: '#main .record .field[data-name="emailAddress"] [data-email-address]',
    phoneNumber: '#main .record .field[data-name="phoneNumber"] [data-phone-number]',
  },
} as const;

export const HIGHLIGHT_CLASS = 'espo-agent-highlight';
/** How long the outline stays on. */
export const HIGHLIGHT_MS = 1200;
/** Pause between showing the outline and acting, so the screencast shows it before the value changes. */
export const HIGHLIGHT_LEAD_MS = 250;
