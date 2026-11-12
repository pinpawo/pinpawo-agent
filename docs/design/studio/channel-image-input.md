# Channel image input

Timeline messages retain their structured `deliverables`, including references on
reply targets. Message creation and mentions do not dispatch a Pet, so they do not
construct a dispatch attachment payload. A future independent consumer must define
its own input and attachment handling. Host dispatch attachment admission remains
independent of Timeline storage.
