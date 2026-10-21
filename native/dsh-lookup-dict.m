/**
 * dsh-lookup-dict — tiny macOS system-dictionary bridge for dsh-plugin-look-up.
 *
 * Reads the definition of one word from the dictionaries the user configured in
 * Dictionary.app by calling DictionaryServices' public `DCSCopyTextDefinition`.
 * That is the same local, offline data source macOS Look Up uses; no network,
 * no accessibility permission, no Apple Events.
 *
 * Usage:
 *   dsh-lookup-dict <word>   -> one JSON object on stdout
 *   dsh-lookup-dict --version-> "1"
 *
 * Exit codes: 0 when a JSON object was written (including `ok:false`),
 * 2 on usage errors. Output is always valid JSON otherwise.
 */

#import <Foundation/Foundation.h>
#import <CoreServices/CoreServices.h>

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

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc > 1 && strcmp(argv[1], "--version") == 0) {
            fputs("1\n", stdout);
            return 0;
        }
        if (argc < 2) {
            write_json(@{@"ok": @NO, @"error": @"usage"});
            return 2;
        }

        NSString *raw = [[NSString alloc] initWithUTF8String:argv[1]];
        if (raw == nil) {
            write_json(@{@"ok": @NO, @"error": @"encoding"});
            return 0;
        }
        NSString *word = [raw stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        if (word.length == 0) {
            write_json(@{@"ok": @NO, @"error": @"empty"});
            return 0;
        }
        if (word.length > 128) {
            write_json(@{@"ok": @NO, @"error": @"too-long"});
            return 0;
        }

        CFRange range = CFRangeMake(0, (CFIndex)word.length);
        CFStringRef copied = DCSCopyTextDefinition(NULL, (__bridge CFStringRef)word, range);
        if (copied == NULL) {
            write_json(@{@"ok": @NO, @"error": @"no-entry", @"word": word});
            return 0;
        }

        NSString *definition = (__bridge_transfer NSString *)copied;
        NSString *trimmed = [definition stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        if (trimmed.length == 0) {
            write_json(@{@"ok": @NO, @"error": @"no-entry", @"word": word});
            return 0;
        }

        write_json(@{
            @"ok": @YES,
            @"word": word,
            @"definition": trimmed,
            @"source": @"DictionaryServices"
        });
    }
    return 0;
}
