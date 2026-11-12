# Channel routing (retired)

The former Channel router and mention-driven dispatch have been removed. Channel
stores messages from Human and Pet Instance producers and publishes a live event;
it does not select recipients or dispatch a Pet. A future Pet Head can subscribe
independently, but is not part of this implementation. Messages and mentions do
not automatically start a Pet. See [Channel model](channel-model.md) and
[addressing and execution](channel-addressing-and-execution.md).
