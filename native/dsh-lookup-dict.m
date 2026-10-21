/**
 * dsh-lookup-dict — macOS system-dictionary bridge for dsh-plugin-look-up.
 *
 * One process performs exactly one DictionaryServices `DCSCopyDefinitionMarkup`
 * call and returns the full entry HTML plus the dictionary's own
 * `DefaultStyle.css`. That is the same content and stylesheet macOS Dictionary
 * renders, so the in-chat card can show the complete entry.
 *
 * The private markup function takes two trailing pointers after the range (a
 * reserved slot and a `CFURLRef *` for the stylesheet). Leaving them
 * uninitialized makes the framework write through garbage and crash.
 *
 * Usage:
 *   dsh-lookup-dict <word>                          -> the system default entry
 *   dsh-lookup-dict <word> --dictionary <substring> -> first matching dictionary
 *   dsh-lookup-dict --version                       -> "4"
 *
 * Exit codes: 0 when JSON was written (including `ok:false`), 2 on usage errors.
 */

#import <Foundation/Foundation.h>
#import <CoreServices/CoreServices.h>
#include <dlfcn.h>

typedef CFStringRef (*MarkupFn)(DCSDictionaryRef, CFStringRef, CFRange, void *, CFURLRef *);
typedef CFTypeRef (*AvailableFn)(void);
typedef CFStringRef (*NameFn)(DCSDictionaryRef);
typedef CFStringRef (*ShortNameFn)(DCSDictionaryRef);

static void write_json(NSDictionary *payload) {
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&error];
    if (data == nil) {
        fputs("{\"ok\":false,\"error\":\"encode\"}\n", stdout);
        return;
    }
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
}

static NSString *body_of(NSString *html) {
    NSRange open = [html rangeOfString:@"<body>"];
    NSRange close = [html rangeOfString:@"</body>"];
    if (open.location == NSNotFound || close.location == NSNotFound || close.location <= open.location) return html;
    return [html substringWithRange:NSMakeRange(open.location + open.length, close.location - open.location - open.length)];
}

static NSString *first_match(NSString *text, NSString *pattern) {
    NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:pattern options:0 error:nil];
    NSTextCheckingResult *match = [regex firstMatchInString:text options:0 range:NSMakeRange(0, text.length)];
    if (match == nil || match.numberOfRanges < 2) return nil;
    return [text substringWithRange:[match rangeAtIndex:1]];
}

static NSString *sanitize_fragment(NSString *html) {
    NSRegularExpression *blocks = [NSRegularExpression regularExpressionWithPattern:@"<(script|iframe|object|embed)\\b[\\s\\S]*?</\\1\\s*>" options:NSRegularExpressionCaseInsensitive error:nil];
    NSString *clean = [blocks stringByReplacingMatchesInString:html options:0 range:NSMakeRange(0, html.length) withTemplate:@""];
    NSRegularExpression *handlers = [NSRegularExpression regularExpressionWithPattern:@"\\s+on[a-zA-Z]+\\s*=\\s*(\"[^\"]*\"|'[^']*')" options:0 error:nil];
    clean = [handlers stringByReplacingMatchesInString:clean options:0 range:NSMakeRange(0, clean.length) withTemplate:@""];
    return [clean stringByReplacingOccurrencesOfString:@"javascript:" withString:@"about:blank#"];
}

/** The dictionary's stylesheet, delivered by the markup call itself. */
static NSString *read_style(CFURLRef url) {
    if (url == NULL) return @"";
    NSData *data = [NSData dataWithContentsOfURL:(__bridge NSURL *)url];
    if (data == nil) return @"";
    NSString *css = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (css == nil) css = [[NSString alloc] initWithData:data encoding:NSUnicodeStringEncoding];
    return css ?: @"";
}

/** `<...>/Name.dictionary/Contents/Resources/DefaultStyle.css` -> `Name`. */
static NSString *dictionary_name_from_style(CFURLRef url) {
    if (url == NULL) return @"System dictionary";
    NSString *path = [(__bridge NSURL *)url path];
    NSRange marker = [path rangeOfString:@".dictionary/"];
    if (marker.location == NSNotFound) return @"System dictionary";
    NSString *prefix = [path substringToIndex:marker.location];
    NSString *name = [prefix lastPathComponent];
    return name.length > 0 ? name : @"System dictionary";
}

/** First dictionary whose display name contains `filter`; NULL when absent. */
static DCSDictionaryRef find_dictionary(AvailableFn available, NameFn name_of, NSString *filter) {
    if (available == NULL || name_of == NULL) return NULL;
    CFTypeRef dictionaries = available();
    if (dictionaries == NULL) return NULL;

    CFIndex count = 0;
    const void **values = NULL;
    if (CFGetTypeID(dictionaries) == CFSetGetTypeID()) {
        count = CFSetGetCount((CFSetRef)dictionaries);
        values = malloc(sizeof(void *) * (size_t)count);
        CFSetGetValues((CFSetRef)dictionaries, values);
    } else if (CFGetTypeID(dictionaries) == CFArrayGetTypeID()) {
        count = CFArrayGetCount((CFArrayRef)dictionaries);
        values = malloc(sizeof(void *) * (size_t)count);
        for (CFIndex i = 0; i < count; i++) values[i] = CFArrayGetValueAtIndex((CFArrayRef)dictionaries, i);
    }

    DCSDictionaryRef found = NULL;
    for (CFIndex i = 0; i < count; i++) {
        DCSDictionaryRef candidate = (DCSDictionaryRef)values[i];
        CFStringRef name = name_of(candidate);
        if (name != NULL && [(__bridge NSString *)name containsString:filter]) {
            found = candidate;
            break;
        }
    }
    free(values);
    return found;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc > 1 && strcmp(argv[1], "--version") == 0) {
            fputs("4\n", stdout);
            return 0;
        }
        if (argc < 2) {
            write_json(@{@"ok": @NO, @"error": @"usage"});
            return 2;
        }

        NSString *word = [[[NSString alloc] initWithUTF8String:argv[1]] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        BOOL entries_mode = NO;
        NSString *filter = nil;
        if (argc > 2 && strcmp(argv[2], "--entries") == 0) {
            entries_mode = YES;
        } else if (argc > 3 && strcmp(argv[2], "--dictionary") == 0) {
            entries_mode = YES;
            filter = [[NSString alloc] initWithUTF8String:argv[3]];
        }

        if (word.length == 0) {
            write_json(@{@"ok": @NO, @"error": @"empty"});
            return 0;
        }
        if (word.length > 128) {
            write_json(@{@"ok": @NO, @"error": @"too-long"});
            return 0;
        }

        MarkupFn markup = (MarkupFn)dlsym(RTLD_DEFAULT, "DCSCopyDefinitionMarkup");
        AvailableFn available = (AvailableFn)dlsym(RTLD_DEFAULT, "DCSCopyAvailableDictionaries");
        NameFn name_of = (NameFn)dlsym(RTLD_DEFAULT, "DCSDictionaryGetName");
        ShortNameFn short_name_of = (ShortNameFn)dlsym(RTLD_DEFAULT, "DCSDictionaryGetShortName");
        if (markup == NULL) {
            write_json(@{@"ok": @NO, @"error": @"no-markup-api"});
            return 0;
        }

        CFStringRef word_ref = CFStringCreateWithCString(NULL, word.UTF8String, kCFStringEncodingUTF8);
        if (word_ref == NULL) {
            write_json(@{@"ok": @NO, @"error": @"encoding"});
            return 0;
        }
        CFRange range = CFRangeMake(0, CFStringGetLength(word_ref));

        // 0.1.x compatibility: the old Host calls the helper without a mode
        // flag and expects the flat plain-text definition.
        if (!entries_mode) {
            CFStringRef plain = DCSCopyTextDefinition(NULL, word_ref, range);
            if (plain == NULL) {
                write_json(@{@"ok": @NO, @"error": @"no-entry", @"word": word});
            } else {
                write_json(@{@"ok": @YES, @"word": word, @"definition": (__bridge_transfer NSString *)plain});
            }
            return 0;
        }

        DCSDictionaryRef dictionary = NULL;
        NSString *dictionary_name = nil;
        NSString *short_name = @"";

        if (filter != nil) {
            dictionary = find_dictionary(available, name_of, filter);
            if (dictionary == NULL) {
                write_json(@{@"ok": @YES, @"word": word, @"entries": @[]});
                return 0;
            }
            CFStringRef name = name_of != NULL ? name_of(dictionary) : NULL;
            if (name != NULL) dictionary_name = (__bridge NSString *)name;
            CFStringRef short_ref = short_name_of != NULL ? short_name_of(dictionary) : NULL;
            if (short_ref != NULL) short_name = (__bridge NSString *)short_ref;
        }

        CFURLRef style_url = NULL;
        CFStringRef copied = markup(dictionary, word_ref, range, NULL, &style_url);
        if (copied == NULL) {
            write_json(@{@"ok": @YES, @"word": word, @"entries": @[]});
            return 0;
        }

        NSString *html = (__bridge_transfer NSString *)copied;
        NSString *title = first_match(html, @"<d:entry[^>]*\\bd:title=\"([^\"]*)\"");
        NSString *identifier = first_match(html, @"<d:entry[^>]*\\bid=\"([^\"]*)\"");
        if (dictionary_name.length == 0) dictionary_name = dictionary_name_from_style(style_url);

        NSDictionary *entry = @{
            @"dictionary": dictionary_name ?: @"System dictionary",
            @"shortName": short_name,
            @"title": title ?: word,
            @"id": identifier ?: @"",
            @"html": sanitize_fragment(body_of(html)),
            @"css": read_style(style_url)
        };
        write_json(@{@"ok": @YES, @"word": word, @"entries": @[entry], @"default": filter == nil ? @YES : @NO});
    }
    return 0;
}
