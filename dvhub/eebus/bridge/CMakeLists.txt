# dvhub-eebus — built as a subproject of the pinned openeebus tree (see
# ../build.sh), exactly like openeebus' own examples, so it inherits the
# library's include paths, compile options and dependencies.
cmake_minimum_required(VERSION 3.16)

set(PROJECT_NAME "dvhub-eebus")

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

add_executable(${PROJECT_NAME})

# cJSON for the NDJSON protocol (openeebus links it only privately).
find_package(PkgConfig REQUIRED)
pkg_check_modules(DVHUB_CJSON REQUIRED IMPORTED_TARGET libcjson)

target_sources(${PROJECT_NAME}
    PRIVATE
    main.c
    bridge.c
    certgen.c
    out.c
)

target_include_directories(${PROJECT_NAME}
    PRIVATE
    ${PROJECT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}
)

target_compile_options(${PROJECT_NAME}
    PRIVATE
    -Wall -Wextra
)

target_link_libraries(${PROJECT_NAME}
    PRIVATE
    m
    pthread
    crypto
    PkgConfig::DVHUB_CJSON
    openeebus
)
