CC ?= gcc
CFLAGS = -O2 -Wall -Wextra -fPIC -std=c11
TARGET = libfsc-codec.so
TEST = test_codec

.PHONY: all clean test

all: $(TARGET)

$(TARGET): fsc_codec.c fsc_codec.h
	$(CC) $(CFLAGS) -shared -o $@ fsc_codec.c
	@ls -lh $@
	@echo "Build complete: $@"

test: test_codec.c fsc_codec.c fsc_codec.h
	$(CC) $(CFLAGS) -o $(TEST) test_codec.c fsc_codec.c
	./$(TEST)

clean:
	rm -f $(TARGET) $(TEST)
