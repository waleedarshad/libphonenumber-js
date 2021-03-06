// This is an enhanced port of Google Android `libphonenumber`'s
// `asyoutypeformatter.js` of 17th November, 2016.
//
// https://github.com/googlei18n/libphonenumber/blob/8d21a365061de2ba0675c878a710a7b24f74d2ae/javascript/i18n/phonenumbers/asyoutypeformatter.js

import Metadata from './metadata'

import
{
	matches_entirely,
	VALID_DIGITS,
	VALID_PUNCTUATION,
	PLUS_CHARS,
	extractCountryCallingCode
}
from './common'

import
{
	extract_formatted_phone_number,
	find_country_code,
	strip_national_prefix_and_carrier_code
}
from './parse'

import
{
	FIRST_GROUP_PATTERN,
	format_national_number_using_format,
	local_to_international_style
}
from './format'

import
{
	check_number_length_for_type
}
from './getNumberType'

import parseIncompletePhoneNumber from './parseIncompletePhoneNumber'

// Used in phone number format template creation.
// Could be any digit, I guess.
const DUMMY_DIGIT = '9'
const DUMMY_DIGIT_MATCHER = new RegExp(DUMMY_DIGIT, 'g')
// I don't know why is it exactly `15`
const LONGEST_NATIONAL_PHONE_NUMBER_LENGTH = 15
// Create a phone number consisting only of the digit 9 that matches the
// `number_pattern` by applying the pattern to the "longest phone number" string.
const LONGEST_DUMMY_PHONE_NUMBER = repeat(DUMMY_DIGIT, LONGEST_NATIONAL_PHONE_NUMBER_LENGTH)

// The digits that have not been entered yet will be represented by a \u2008,
// the punctuation space.
export const DIGIT_PLACEHOLDER = 'x' // '\u2008' (punctuation space)
const DIGIT_PLACEHOLDER_MATCHER = new RegExp(DIGIT_PLACEHOLDER)
const DIGIT_PLACEHOLDER_MATCHER_GLOBAL = new RegExp(DIGIT_PLACEHOLDER, 'g')

// A pattern that is used to match character classes in regular expressions.
// An example of a character class is "[1-4]".
const CHARACTER_CLASS_PATTERN = /\[([^\[\]])*\]/g

// Any digit in a regular expression that actually denotes a digit. For
// example, in the regular expression "80[0-2]\d{6,10}", the first 2 digits
// (8 and 0) are standalone digits, but the rest are not.
// Two look-aheads are needed because the number following \\d could be a
// two-digit number, since the phone number can be as long as 15 digits.
const STANDALONE_DIGIT_PATTERN = /\d(?=[^,}][^,}])/g

// A pattern that is used to determine if a `format` is eligible
// to be used by the "as you type formatter".
// It is eligible when the `format` contains groups of the dollar sign
// followed by a single digit, separated by valid phone number punctuation.
// This prevents invalid punctuation (such as the star sign in Israeli star numbers)
// getting into the output of the "as you type formatter".
const ELIGIBLE_FORMAT_PATTERN = new RegExp
(
	'^' +
	'[' + VALID_PUNCTUATION + ']*' +
	'(\\$\\d[' + VALID_PUNCTUATION + ']*)+' +
	'$'
)

// This is the minimum length of the leading digits of a phone number
// to guarantee the first "leading digits pattern" for a phone number format
// to be preemptive.
const MIN_LEADING_DIGITS_LENGTH = 3

const VALID_INCOMPLETE_PHONE_NUMBER =
	'[' + PLUS_CHARS + ']{0,1}' +
	'[' +
		VALID_PUNCTUATION +
		VALID_DIGITS +
	']*'

const VALID_INCOMPLETE_PHONE_NUMBER_PATTERN = new RegExp('^' + VALID_INCOMPLETE_PHONE_NUMBER + '$', 'i')

export default class AsYouType
{
	// Not setting `options` to a constructor argument
	// not to break backwards compatibility
	// for older versions of the library.
	options = {}

	/**
	 * @param {string} [country_code] - The default country used for parsing non-international phone numbers.
	 * @param {Object} metadata
	 */
	constructor(country_code, metadata)
	{
		this.metadata = new Metadata(metadata)

		if (country_code && this.metadata.hasCountry(country_code))
		{
			this.default_country = country_code
		}

		this.reset()
	}

	input(text)
	{
		// Parse input

		let extracted_number = extract_formatted_phone_number(text) || ''

		// Special case for a lone '+' sign
		// since it's not considered a possible phone number.
		if (!extracted_number)
		{
			if (text && text.indexOf('+') >= 0)
			{
				extracted_number = '+'
			}
		}

		// Validate possible first part of a phone number
		if (!matches_entirely(extracted_number, VALID_INCOMPLETE_PHONE_NUMBER_PATTERN))
		{
			return this.current_output
		}

		return this.process_input(parseIncompletePhoneNumber(extracted_number))
	}

	process_input(input)
	{
		// If an out of position '+' sign detected
		// (or a second '+' sign),
		// then just drop it from the input.
		if (input[0] === '+')
		{
			if (!this.parsed_input)
			{
				this.parsed_input += '+'

				// If a default country was set
				// then reset it because an explicitly international
				// phone number is being entered
				this.reset_countriness()
			}

			input = input.slice(1)
		}

		// Raw phone number
		this.parsed_input += input

		// // Reset phone number validation state
		// this.valid = false

		// Add digits to the national number
		this.national_number += input

		// TODO: Deprecated: rename `this.national_number`
		// to `this.nationalNumber` and remove `.getNationalNumber()`.

		// Try to format the parsed input

		if (this.is_international())
		{
			if (!this.countryCallingCode)
			{
				// No need to format anything
				// if there's no national phone number.
				// (e.g. just the country calling code)
				if (!this.national_number)
				{
					// Return raw phone number
					return this.parsed_input
				}

				// If one looks at country phone codes
				// then he can notice that no one country phone code
				// is ever a (leftmost) substring of another country phone code.
				// So if a valid country code is extracted so far
				// then it means that this is the country code.

				// If no country phone code could be extracted so far,
				// then just return the raw phone number,
				// because it has no way of knowing
				// how to format the phone number so far.
				if (!this.extract_country_calling_code())
				{
					// Return raw phone number
					return this.parsed_input
				}

				// Initialize country-specific data
				this.initialize_phone_number_formats_for_this_country_calling_code()
				this.reset_format()
				this.determine_the_country()
			}
			// `this.country` could be `undefined`,
			// for instance, when there is ambiguity
			// in a form of several different countries
			// each corresponding to the same country phone code
			// (e.g. NANPA: USA, Canada, etc),
			// and there's not enough digits entered
			// to reliably determine the country
			// the phone number belongs to.
			// Therefore, in cases of such ambiguity,
			// each time something is input,
			// try to determine the country
			// (if it's not determined yet).
			else if (!this.country)
			{
				this.determine_the_country()
			}
		}
		else
		{
			// Some national prefixes are substrings of other national prefixes
			// (for the same country), therefore try to extract national prefix each time
			// because a longer national prefix might be available at some point in time.

			const previous_national_prefix = this.national_prefix
			this.national_number = this.national_prefix + this.national_number

			// Possibly extract a national prefix
			this.extract_national_prefix()

			if (this.national_prefix !== previous_national_prefix)
			{
				// National number has changed
				// (due to another national prefix been extracted)
				// therefore national number has changed
				// therefore reset all previous formatting data.
				// (and leading digits matching state)
				this.matching_formats = this.available_formats
				this.reset_format()
			}
		}

		if (!this.should_format())
		{
			return this.format_as_non_formatted_number()
		}

		// Check the available phone number formats
		// based on the currently available leading digits.
		this.match_formats_by_leading_digits()

		// Format the phone number (given the next digits)
		const formatted_national_phone_number = this.format_national_phone_number(input)

		// If the phone number could be formatted,
		// then return it, possibly prepending with country phone code
		// (for international phone numbers only)
		if (formatted_national_phone_number)
		{
			return this.full_phone_number(formatted_national_phone_number)
		}

		// If the phone number couldn't be formatted,
		// then just fall back to the raw phone number.
		return this.parsed_input
	}

	format_as_non_formatted_number()
	{
		if (this.is_international() && this.countryCallingCode)
		{
			if (this.national_number)
			{
				// For convenience, the public `.template` property
				// contains the whole international number
				// if the phone number being input is international:
				// 'x' for the '+' sign, 'x'es for the country phone code,
				// a spacebar and then the template for the national number digits.
				this.template = DIGIT_PLACEHOLDER + repeat(DIGIT_PLACEHOLDER, this.countryCallingCode.length) + ' ' + repeat(DIGIT_PLACEHOLDER, this.national_number.length)

				return `+${this.countryCallingCode} ${this.national_number}`
			}

			return `+${this.countryCallingCode}`
		}

		return this.parsed_input
	}

	format_national_phone_number(next_digits)
	{
		// Format the next phone number digits
		// using the previously chosen phone number format.
		//
		// This is done here because if `attempt_to_format_complete_phone_number`
		// was placed before this call then the `template`
		// wouldn't reflect the situation correctly (and would therefore be inconsistent)
		//
		let national_number_formatted_with_previous_format
		if (this.chosen_format)
		{
			national_number_formatted_with_previous_format = this.format_next_national_number_digits(next_digits)
		}

		// See if the input digits can be formatted properly already. If not,
		// use the results from format_next_national_number_digits(), which does formatting
		// based on the formatting pattern chosen.

		const formatted_number = this.attempt_to_format_complete_phone_number()

		// Just because a phone number doesn't have a suitable format
		// that doesn't mean that the phone is invalid
		// because phone number formats only format phone numbers,
		// they don't validate them and some (rare) phone numbers
		// are meant to stay non-formatted.
		if (formatted_number)
		{
			// if (this.country)
			// {
			// 	this.valid = true
			// }

			return formatted_number
		}

		// For some phone number formats national prefix

		// If the previously chosen phone number format
		// didn't match the next (current) digit being input
		// (leading digits pattern didn't match).
		if (this.choose_another_format())
		{
			// And a more appropriate phone number format
			// has been chosen for these `leading digits`,
			// then format the national phone number (so far)
			// using the newly selected phone number pattern.

			// Will return `undefined` if it couldn't format
			// the supplied national number
			// using the selected phone number pattern.

			return this.reformat_national_number()
		}

		// If could format the next (current) digit
		// using the previously chosen phone number format
		// then return the formatted number so far.

		// If no new phone number format could be chosen,
		// and couldn't format the supplied national number
		// using the selected phone number pattern,
		// then it will return `undefined`.

		return national_number_formatted_with_previous_format
	}

	reset()
	{
		// Input stripped of non-phone-number characters.
		// Can only contain a possible leading '+' sign and digits.
		this.parsed_input = ''

		this.current_output = ''

		// This contains the national prefix that has been extracted. It contains only
		// digits without formatting.
		this.national_prefix = ''

		this.national_number = ''

		this.reset_countriness()

		this.reset_format()

		// this.valid = false

		return this
	}

	reset_country()
	{
		if (this.is_international())
		{
			this.country = undefined
		}
		else
		{
			this.country = this.default_country
		}
	}

	reset_countriness()
	{
		this.reset_country()

		if (this.default_country && !this.is_international())
		{
			this.metadata.country(this.default_country)
			this.countryCallingCode = this.metadata.countryCallingCode()

			this.initialize_phone_number_formats_for_this_country_calling_code()
		}
		else
		{
			this.metadata.country(undefined)
			this.countryCallingCode = undefined

			this.available_formats = []
			this.matching_formats = this.available_formats
		}
	}

	reset_format()
	{
		this.chosen_format = undefined
		this.template = undefined
		this.partially_populated_template = undefined
		this.last_match_position = -1
	}

	// Format each digit of national phone number (so far)
	// using the newly selected phone number pattern.
	reformat_national_number()
	{
		// Format each digit of national phone number (so far)
		// using the selected phone number pattern.
		return this.format_next_national_number_digits(this.national_number)
	}

	initialize_phone_number_formats_for_this_country_calling_code()
	{
		// Get all "eligible" phone number formats for this country
		this.available_formats = this.metadata.formats().filter((format) =>
		{
			return ELIGIBLE_FORMAT_PATTERN.test(format.internationalFormat())
		})

		this.matching_formats = this.available_formats
	}

	match_formats_by_leading_digits()
	{
		const leading_digits = this.national_number

		// "leading digits" pattern list starts with
		// one of a maximum length of 3 digits,
		// and then with each additional digit
		// a more precise "leading digits" pattern is specified.

		let index_of_leading_digits_pattern = leading_digits.length - MIN_LEADING_DIGITS_LENGTH

		if (index_of_leading_digits_pattern < 0)
		{
			index_of_leading_digits_pattern = 0
		}

		this.matching_formats = this.matching_formats.filter((format) =>
		{
			const leading_digits_pattern_count = format.leadingDigitsPatterns().length

			// Keep everything that isn't restricted by leading digits.
			if (leading_digits_pattern_count === 0)
			{
				return true
			}

			const leading_digits_pattern_index = Math.min(index_of_leading_digits_pattern, leading_digits_pattern_count - 1)
			const leading_digits_pattern = format.leadingDigitsPatterns()[leading_digits_pattern_index]

			// Brackets are required for `^` to be applied to
			// all or-ed (`|`) parts, not just the first one.
			return new RegExp(`^(${leading_digits_pattern})`).test(leading_digits)
		})

		// If there was a phone number format chosen
		// and it no longer holds given the new leading digits then reset it.
		// The test for this `if` condition is marked as:
		// "Reset a chosen format when it no longer holds given the new leading digits".
		// To construct a valid test case for this one can find a country
		// in `PhoneNumberMetadata.xml` yielding one format for 3 `<leadingDigits>`
		// and yielding another format for 4 `<leadingDigits>` (Australia in this case).
		if (this.chosen_format && this.matching_formats.indexOf(this.chosen_format) === -1)
		{
			this.reset_format()
		}
	}

	should_format()
	{
		// Start matching any formats at all when the national number
		// entered so far is at least 3 digits long,
		// otherwise format matching would give false negatives
		// like when the digits entered so far are `2`
		// and the leading digits pattern is `21` –
		// it's quite obvious in this case that the format could be the one
		// but due to the absence of further digits it would give false negative.
		//
		// Google could have provided leading digits patterns starting
		// with a single digit but they chose not to (for whatever reasons).
		//
		return this.national_number >= MIN_LEADING_DIGITS_LENGTH
	}

	// Check to see if there is an exact pattern match for these digits. If so, we
	// should use this instead of any other formatting template whose
	// `leadingDigitsPattern` also matches the input.
	attempt_to_format_complete_phone_number()
	{
		for (const format of this.matching_formats)
		{
			const matcher = new RegExp(`^(?:${format.pattern()})$`)

			if (!matcher.test(this.national_number))
			{
				continue
			}

			if (!this.is_format_applicable(format))
			{
				continue
			}

			// To leave the formatter in a consistent state
			this.reset_format()
			this.chosen_format = format

			const formatted_number = format_national_number_using_format
			(
				this.national_number,
				format,
				this.is_international(),
				this.national_prefix.length > 0,
				this.metadata
			)

			// Set `this.template` and `this.partially_populated_template`.
			//
			// `else` case doesn't ever happen
			// with the current metadata,
			// but just in case.
			//
			/* istanbul ignore else */
			if (this.create_formatting_template(format))
			{
				// Populate `this.partially_populated_template`
				this.reformat_national_number()
			}
			else
			{
				// Prepend `+CountryCode` in case of an international phone number
				const full_number = this.full_phone_number(formatted_number)
				this.template = full_number.replace(/[\d\+]/g, DIGIT_PLACEHOLDER)
				this.partially_populated_template = full_number
			}

			return formatted_number
		}
	}

	// Prepends `+CountryCode` in case of an international phone number
	full_phone_number(formatted_national_number)
	{
		if (this.is_international())
		{
			return `+${this.countryCallingCode} ${formatted_national_number}`
		}

		return formatted_national_number
	}

	// Extracts the country calling code from the beginning
	// of the entered `national_number` (so far),
	// and places the remaining input into the `national_number`.
	extract_country_calling_code()
	{
		const { countryCallingCode, number } = extractCountryCallingCode(this.parsed_input, this.default_country, this.metadata)

		if (!countryCallingCode)
		{
			return
		}

		this.countryCallingCode = countryCallingCode

		// Sometimes people erroneously write national prefix
		// as part of an international number, e.g. +44 (0) ....
		// This violates the standards for international phone numbers,
		// so "As You Type" formatter assumes no national prefix
		// when parsing a phone number starting from `+`.
		// Even if it did attempt to filter-out that national prefix
		// it would look weird for a user trying to enter a digit
		// because from user's perspective the keyboard "wouldn't be working".
		this.national_number = number

		this.metadata.chooseCountryByCountryCallingCode(countryCallingCode)
		return this.metadata.selectedCountry() !== undefined
	}

	extract_national_prefix()
	{
		this.national_prefix = ''

		if (!this.metadata.selectedCountry())
		{
			return
		}

		// Only strip national prefixes for non-international phone numbers
		// because national prefixes can't be present in international phone numbers.
		// Otherwise, while forgiving, it would parse a NANPA number `+1 1877 215 5230`
		// first to `1877 215 5230` and then, stripping the leading `1`, to `877 215 5230`,
		// and then it would assume that's a valid number which it isn't.
		// So no forgiveness for grandmas here.
		// The issue asking for this fix:
		// https://github.com/catamphetamine/libphonenumber-js/issues/159
		const { number: potential_national_number } = strip_national_prefix_and_carrier_code(this.national_number, this.metadata)

		// We require that the NSN remaining after stripping the national prefix and
		// carrier code be long enough to be a possible length for the region.
		// Otherwise, we don't do the stripping, since the original number could be
		// a valid short number.
		if (!this.metadata.possibleLengths() ||
			this.is_possible_number(this.national_number) &&
			!this.is_possible_number(potential_national_number))
		{
			// Verify the parsed national (significant) number for this country
			//
			// If the original number (before stripping national prefix) was viable,
			// and the resultant number is not, then prefer the original phone number.
			// This is because for some countries (e.g. Russia) the same digit could be both
			// a national prefix and a leading digit of a valid national phone number,
			// like `8` is the national prefix for Russia and both
			// `8 800 555 35 35` and `800 555 35 35` are valid numbers.
			if (matches_entirely(this.national_number, this.metadata.nationalNumberPattern()) &&
				!matches_entirely(potential_national_number, this.metadata.nationalNumberPattern()))
			{
				return
			}
		}

		this.national_prefix = this.national_number.slice(0, this.national_number.length - potential_national_number.length)
		this.national_number = potential_national_number

		return this.national_prefix
	}

	is_possible_number(number)
	{
		const validation_result = check_number_length_for_type(number, undefined, this.metadata)
		switch (validation_result)
		{
			case 'IS_POSSIBLE':
				return true
			// case 'IS_POSSIBLE_LOCAL_ONLY':
			// 	return !this.is_international()
			default:
				return false
		}
	}

	choose_another_format()
	{
		// When there are multiple available formats, the formatter uses the first
		// format where a formatting template could be created.
		for (const format of this.matching_formats)
		{
			// If this format is currently being used
			// and is still possible, then stick to it.
			if (this.chosen_format === format)
			{
				return
			}

			// If this `format` is suitable for "as you type",
			// then extract the template from this format
			// and use it to format the phone number being input.

			if (!this.is_format_applicable(format))
			{
				continue
			}

			if (!this.create_formatting_template(format))
			{
				continue
			}

			this.chosen_format = format

			// With a new formatting template, the matched position
			// using the old template needs to be reset.
			this.last_match_position = -1

			return true
		}

		// No format matches the phone number,
		// therefore set `country` to `undefined`
		// (or to the default country).
		this.reset_country()

		// No format matches the national phone number entered
		this.reset_format()
	}

	is_format_applicable(format)
	{
		// If national prefix is mandatory for this phone number format
		// and the user didn't input the national prefix,
		// then this phone number format isn't suitable.
		if (!this.is_international() && !this.national_prefix && format.nationalPrefixIsMandatoryWhenFormatting())
		{
			return false
		}

		return true
	}

	create_formatting_template(format)
	{
		// The formatter doesn't format numbers when numberPattern contains '|', e.g.
		// (20|3)\d{4}. In those cases we quickly return.
		// (Though there's no such format in current metadata)
		/* istanbul ignore if */
		if (format.pattern().indexOf('|') >= 0)
		{
			return
		}

		// Get formatting template for this phone number format
		const template = this.get_template_for_phone_number_format_pattern(format)

		// If the national number entered is too long
		// for any phone number format, then abort.
		if (!template)
		{
			return
		}

		// This one is for national number only
		this.partially_populated_template = template

		// For convenience, the public `.template` property
		// contains the whole international number
		// if the phone number being input is international:
		// 'x' for the '+' sign, 'x'es for the country phone code,
		// a spacebar and then the template for the formatted national number.
		if (this.is_international())
		{
			this.template = DIGIT_PLACEHOLDER + repeat(DIGIT_PLACEHOLDER, this.countryCallingCode.length) + ' ' + template
		}
		// For local numbers, replace national prefix
		// with a digit placeholder.
		else
		{
			this.template = template.replace(/\d/g, DIGIT_PLACEHOLDER)
		}

		// This one is for the full phone number
		return this.template
	}

	// Generates formatting template for a phone number format
	get_template_for_phone_number_format_pattern(format)
	{
		// A very smart trick by the guys at Google
		const number_pattern = format.pattern()
			// Replace anything in the form of [..] with \d
			.replace(CHARACTER_CLASS_PATTERN, '\\d')
			// Replace any standalone digit (not the one in `{}`) with \d
			.replace(STANDALONE_DIGIT_PATTERN, '\\d')

		// This match will always succeed,
		// because the "longest dummy phone number"
		// has enough length to accomodate any possible
		// national phone number format pattern.
		let dummy_phone_number_matching_format_pattern = LONGEST_DUMMY_PHONE_NUMBER.match(number_pattern)[0]

		// If the national number entered is too long
		// for any phone number format, then abort.
		if (this.national_number.length > dummy_phone_number_matching_format_pattern.length)
		{
			return
		}

		// Prepare the phone number format
		const number_format = this.get_format_format(format)

		// Get a formatting template which can be used to efficiently format
		// a partial number where digits are added one by one.

		// Below `strict_pattern` is used for the
		// regular expression (with `^` and `$`).
		// This wasn't originally in Google's `libphonenumber`
		// and I guess they don't really need it
		// because they're not using "templates" to format phone numbers
		// but I added `strict_pattern` after encountering
		// South Korean phone number formatting bug.
		//
		// Non-strict regular expression bug demonstration:
		//
		// this.national_number : `111111111` (9 digits)
		//
		// number_pattern : (\d{2})(\d{3,4})(\d{4})
		// number_format : `$1 $2 $3`
		// dummy_phone_number_matching_format_pattern : `9999999999` (10 digits)
		//
		// '9999999999'.replace(new RegExp(/(\d{2})(\d{3,4})(\d{4})/g), '$1 $2 $3') = "99 9999 9999"
		//
		// template : xx xxxx xxxx
		//
		// But the correct template in this case is `xx xxx xxxx`.
		// The template was generated incorrectly because of the
		// `{3,4}` variability in the `number_pattern`.
		//
		// The fix is, if `this.national_number` has already sufficient length
		// to satisfy the `number_pattern` completely then `this.national_number` is used
		// instead of `dummy_phone_number_matching_format_pattern`.

		const strict_pattern = new RegExp('^' + number_pattern + '$')
		const national_number_dummy_digits = this.national_number.replace(/\d/g, DUMMY_DIGIT)

		// If `this.national_number` has already sufficient length
		// to satisfy the `number_pattern` completely then use it
		// instead of `dummy_phone_number_matching_format_pattern`.
		if (strict_pattern.test(national_number_dummy_digits))
		{
			dummy_phone_number_matching_format_pattern = national_number_dummy_digits
		}

		// Generate formatting template for this phone number format
		return dummy_phone_number_matching_format_pattern
			// Format the dummy phone number according to the format
			.replace(new RegExp(number_pattern), number_format)
			// Replace each dummy digit with a DIGIT_PLACEHOLDER
			.replace(DUMMY_DIGIT_MATCHER, DIGIT_PLACEHOLDER)
	}

	format_next_national_number_digits(digits)
	{
		// Using `.split('')` to iterate through a string here
		// to avoid requiring `Symbol.iterator` polyfill.
		// `.split('')` is generally not safe for Unicode,
		// but in this particular case for `digits` it is safe.
		// for (const digit of digits)
		for (const digit of digits.split(''))
		{
			// If there is room for more digits in current `template`,
			// then set the next digit in the `template`,
			// and return the formatted digits so far.

			// If more digits are entered than the current format could handle
			if (this.partially_populated_template.slice(this.last_match_position + 1).search(DIGIT_PLACEHOLDER_MATCHER) === -1)
			{
				// Reset the current format,
				// so that the new format will be chosen
				// in a subsequent `this.choose_another_format()` call
				// later in code.
				this.chosen_format = undefined
				this.template = undefined
				this.partially_populated_template = undefined
				return
			}

			this.last_match_position = this.partially_populated_template.search(DIGIT_PLACEHOLDER_MATCHER)
			this.partially_populated_template = this.partially_populated_template.replace(DIGIT_PLACEHOLDER_MATCHER, digit)
		}

		// Return the formatted phone number so far.
		return cut_stripping_dangling_braces(this.partially_populated_template, this.last_match_position + 1)

		// The old way which was good for `input-format` but is not so good
		// for `react-phone-number-input`'s default input (`InputBasic`).
		// return close_dangling_braces(this.partially_populated_template, this.last_match_position + 1)
		// 	.replace(DIGIT_PLACEHOLDER_MATCHER_GLOBAL, ' ')
	}

	is_international()
	{
		return this.parsed_input && this.parsed_input[0] === '+'
	}

	get_format_format(format)
	{
		if (this.is_international())
		{
			return local_to_international_style(format.internationalFormat())
		}

		// If national prefix formatting rule is set
		// for this phone number format
		if (format.nationalPrefixFormattingRule())
		{
			// If the user did input the national prefix
			// (or if the national prefix formatting rule does not require national prefix)
			// then maybe make it part of the phone number template
			if (this.national_prefix || !format.usesNationalPrefix())
			{
				// Make the national prefix part of the phone number template
				return format.format().replace(FIRST_GROUP_PATTERN, format.nationalPrefixFormattingRule())
			}
		}

		return format.format()
	}

	// Determines the country of the phone number
	// entered so far based on the country phone code
	// and the national phone number.
	determine_the_country()
	{
		this.country = find_country_code(this.countryCallingCode, this.national_number, this.metadata)
	}

	getNationalNumber()
	{
		return this.national_number
	}

	getTemplate()
	{
		if (!this.template) {
			return
		}

		let index = -1

		let i = 0
		while (i < this.parsed_input.length)
		{
			index = this.template.indexOf(DIGIT_PLACEHOLDER, index + 1)
			i++
		}

		return cut_stripping_dangling_braces(this.template, index + 1)
	}
}

export function strip_dangling_braces(string)
{
	const dangling_braces =[]
	let i = 0
	while (i < string.length)
	{
		if (string[i] === '(') {
			dangling_braces.push(i)
		}
		else if (string[i] === ')') {
			dangling_braces.pop()
		}
		i++
	}

	let start = 0
	let cleared_string = ''
	dangling_braces.push(string.length)
	for (const index of dangling_braces)
	{
		cleared_string += string.slice(start, index)
		start = index + 1
	}

	return cleared_string
}

export function cut_stripping_dangling_braces(string, cut_before_index)
{
	if (string[cut_before_index] === ')') {
		cut_before_index++
	}
	return strip_dangling_braces(string.slice(0, cut_before_index))
}

export function close_dangling_braces(template, cut_before)
{
	const retained_template = template.slice(0, cut_before)

	const opening_braces = count_occurences('(', retained_template)
	const closing_braces = count_occurences(')', retained_template)

	let dangling_braces = opening_braces - closing_braces
	while (dangling_braces > 0 && cut_before < template.length)
	{
		if (template[cut_before] === ')')
		{
			dangling_braces--
		}
		cut_before++
	}

	return template.slice(0, cut_before)
}

// Counts all occurences of a symbol in a string.
// Unicode-unsafe (because using `.split()`).
export function count_occurences(symbol, string)
{
	let count = 0

	// Using `.split('')` to iterate through a string here
	// to avoid requiring `Symbol.iterator` polyfill.
	// `.split('')` is generally not safe for Unicode,
	// but in this particular case for counting brackets it is safe.
	// for (const character of string)
	for (const character of string.split(''))
	{
		if (character === symbol)
		{
			count++
		}
	}

	return count
}

// Repeats a string (or a symbol) N times.
// http://stackoverflow.com/questions/202605/repeat-string-javascript
export function repeat(string, times)
{
	if (times < 1)
	{
		return ''
	}

	let result = ''

	while (times > 1)
	{
		if (times & 1)
		{
			result += string
		}

		times >>= 1
		string += string
	}

	return result + string
}