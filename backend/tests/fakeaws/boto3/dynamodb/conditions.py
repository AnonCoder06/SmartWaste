class Key:
    def __init__(self, name):
        self.name = name

    def eq(self, value):
        return _Eq(self.name, value)


class _Eq:
    def __init__(self, name, value):
        self.name, self.value = name, value
