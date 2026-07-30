# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2026 Sandstorm Development Group, Inc. and contributors
# All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

@0xa376b9d1ca0f4aab;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Util = import "util.capnp";

interface OutboundHttpSession @0xbf91271b527d6f33 {
  # Least-authority outbound HTTP access to a user-approved base URL.
  #
  # Unlike WebSession and ApiSession, this interface is shaped for app-to-service
  # egress. It allows ordinary end-to-end HTTP headers, including Authorization,
  # while the platform continues to control network authority, SSRF protection,
  # and hop-by-hop transport details.

  request @0 (
    method :Method,
    path :Text,
    headers :List(Header),
    body :Data,
    responseStream :Util.ByteStream
  ) -> Response;
  # Make a request with a buffered request body and a streamed response body.
  #
  # `path` must be relative to the granted base URL. Redirect responses are
  # returned to the caller and are not followed automatically.

  requestStreaming @1 (
    method :Method,
    path :Text,
    headers :List(Header),
    responseStream :Util.ByteStream
  ) -> (requestStream :RequestStream);
  # Make a request with a streamed request body and a streamed response body.
  #
  # Call `getResponse()` on the returned stream to observe response headers and
  # status. The response body is written to `responseStream`.

  enum Method {
    get @0;
    post @1;
    put @2;
    patch @3;
    delete @4;
    head @5;
    options @6;
  }

  struct Header {
    name @0 :Text;
    value @1 :Text;
  }

  struct Response {
    statusCode @0 :UInt16;
    statusText @1 :Text;
    headers @2 :List(Header);
  }

  interface RequestStream extends(Util.ByteStream) {
    getResponse @0 () -> Response;
  }

  struct PowerboxTag {
    baseUrl @0 :Text;
    methods @1 :List(Method);
  }
}
